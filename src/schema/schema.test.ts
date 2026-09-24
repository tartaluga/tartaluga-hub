import { describe, expect, it } from 'vitest'
import { validateIdea, validateProject, validateSettings, validateStatus, type ValidateFn } from './validators.js'

const valid = import.meta.glob<unknown>('../../schema/examples/valid/*.json', { eager: true, import: 'default' })
const invalid = import.meta.glob<unknown>('../../schema/examples/invalid/*.json', { eager: true, import: 'default' })

const bySchema: Record<string, ValidateFn> = {
  project: validateProject,
  idea: validateIdea,
  settings: validateSettings,
  status: validateStatus,
}

// valid/project-full.json → project; invalid/project--bad-slug.json → project
function schemaOf(path: string): ValidateFn {
  const file = path.split('/').pop()!
  const name = file.split(/--|-|\./)[0]!
  const fn = bySchema[name]
  if (!fn) throw new Error(`Не понял, к какой схеме относится ${file}`)
  return fn
}

describe('JSON Schema: примеры', () => {
  it('примеры нашлись', () => {
    expect(Object.keys(valid).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(invalid).length).toBeGreaterThanOrEqual(5)
  })

  for (const [path, data] of Object.entries(valid)) {
    it(`проходит: ${path.split('/').pop()}`, () => {
      const validate = schemaOf(path)
      const ok = validate(data)
      expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([])
      expect(ok).toBe(true)
    })
  }

  for (const [path, data] of Object.entries(invalid)) {
    it(`отклоняется: ${path.split('/').pop()}`, () => {
      expect(schemaOf(path)(data)).toBe(false)
    })
  }
})

describe('JSON Schema v1: совместимость (ADR-003)', () => {
  const base = {
    schemaVersion: 1,
    slug: 'x',
    title: 'X',
    status: 'idea',
    createdAt: '2026-09-23T01:00:00+03:00',
    updatedAt: '2026-09-23T01:00:00+03:00',
  }

  it('незнакомые поля не ломают проверку', () => {
    expect(validateProject({ ...base, fromTheFuture: [1, 2, 3] })).toBe(true)
  })

  it('версия выше текущей проходит схему — отказ писать решает приложение, а не схема', () => {
    expect(validateProject({ ...base, schemaVersion: 2 })).toBe(true)
  })

  it('незнакомый тег — не ошибка', () => {
    expect(validateProject({ ...base, tags: ['нет-такого'] })).toBe(true)
  })

  it('новые виды ссылок и записей лога не ломают старое приложение', () => {
    const id = '01K5TQ0000000000000000A001'
    const at = '2026-09-23T01:00:00+03:00'
    expect(
      validateProject({
        ...base,
        links: [{ id, kind: 'figma', value: 'https://figma.com/x' }],
        log: [{ id, at, kind: 'bug', text: 'нашёл баг' }],
      }),
    ).toBe(true)
  })

  it('а новый статус проекта — несовместимое изменение', () => {
    expect(validateProject({ ...base, status: 'blocked' })).toBe(false)
  })
})

describe('JSON Schema: проект v2 (ADR-009)', () => {
  const base = {
    schemaVersion: 2,
    slug: 'x',
    title: 'X',
    status: 'active',
    createdAt: '2026-09-23T01:00:00+03:00',
    updatedAt: '2026-09-23T01:00:00+03:00',
  }
  const id = '01K5TQ0000000000000000C001'
  const keywords = (fn: ValidateFn) => (fn.errors ?? []).map((e) => e.keyword)

  it('doneAt допустим только при status = done', () => {
    expect(validateProject({ ...base, status: 'done', doneAt: '2026-09-24T10:00:00+03:00' })).toBe(true)
    expect(validateProject({ ...base, status: 'done' })).toBe(true)
    for (const status of ['idea', 'active', 'paused', 'archived']) {
      expect(validateProject({ ...base, status, doneAt: '2026-09-24T10:00:00+03:00' }), status).toBe(false)
      expect(keywords(validateProject)).toContain('const')
    }
  })

  it('doneAt — момент со смещением, не дата', () => {
    expect(validateProject({ ...base, status: 'done', doneAt: '2026-09-24' })).toBe(false)
  })

  it('originalDue задачи — только при due', () => {
    expect(validateProject({ ...base, tasks: [{ id, title: 'т', done: false, due: '2026-10-02', originalDue: '2026-10-01' }] })).toBe(true)
    expect(validateProject({ ...base, tasks: [{ id, title: 'т', done: false, due: '2026-10-02' }] })).toBe(true)
    expect(validateProject({ ...base, tasks: [{ id, title: 'т', done: false, originalDue: '2026-10-01' }] })).toBe(false)
    expect(keywords(validateProject)).toContain('dependentRequired')
    expect(validateProject({ ...base, tasks: [{ id, title: 'т', done: false, due: '2026-10-02', originalDue: '2026-10-01T00:00Z' }] })).toBe(false)
  })

  it('у вехи originalDue не бывает', () => {
    const m = { id: '01K5TQ0000000000000000B001', title: 'в', due: '2026-10-01' }
    expect(validateProject({ ...base, milestones: [m] })).toBe(true)
    expect(validateProject({ ...base, milestones: [{ ...m, originalDue: '2026-09-01' }] })).toBe(false)
    expect(keywords(validateProject)).toContain('not')
  })

  it('fromIdea: ideaId, text и createdAt обязательны', () => {
    const fromIdea = { ideaId: '01K5TQ0000000000000000E001', text: 'идея', createdAt: '2026-09-20T10:00:00+03:00' }
    expect(validateProject({ ...base, fromIdea })).toBe(true)
    for (const key of Object.keys(fromIdea)) {
      const broken: Record<string, unknown> = { ...fromIdea }
      delete broken[key]
      expect(validateProject({ ...base, fromIdea: broken }), key).toBe(false)
    }
    expect(validateProject({ ...base, fromIdea: { ...fromIdea, text: '  ' } })).toBe(false)
    expect(validateProject({ ...base, fromIdea: { ...fromIdea, ideaId: 'не-ulid' } })).toBe(false)
  })

  it('версия 1 с новыми полями тоже проходит: версию проверяет приложение', () => {
    expect(validateProject({ ...base, schemaVersion: 1, status: 'done', doneAt: '2026-09-24T10:00:00+03:00' })).toBe(true)
  })
})

describe('JSON Schema: идея и статус (ADR-009)', () => {
  const idea = { schemaVersion: 1, id: '01K5TQ0000000000000000E001', text: 'т', createdAt: '2026-09-23T01:00:00Z' }

  it('идея: project — slug проекта', () => {
    expect(validateIdea({ ...idea, project: 'tartaluga-hub' })).toBe(true)
    expect(validateIdea({ ...idea, project: 'Tartaluga Hub' })).toBe(false)
    expect(validateIdea({ ...idea, project: '' })).toBe(false)
  })

  it('статус: repo.defaultBranch и deployment.creator — необязательные строки', () => {
    const status = (repo: object) => ({ schemaVersion: 1, generatedAt: null, lastSuccess: null, errors: [], projects: { x: { repo: { fullName: 'a/b', ...repo } } } })
    expect(validateStatus(status({}))).toBe(true)
    expect(validateStatus(status({ defaultBranch: 'main', deployment: { creator: 'netlify[bot]' } }))).toBe(true)
    expect(validateStatus(status({ defaultBranch: 1 }))).toBe(false)
    expect(validateStatus(status({ deployment: { creator: null } }))).toBe(false)
  })
})

// Импорт CommonJS-хелперов Ajv «по умолчанию» Vitest понимает, а продакшен-сборка Rollup — нет:
// в браузере разбор любого проекта падал с «func1 is not a function». Хелперы встраиваются в файл.
describe('validators.js самодостаточен', () => {
  const source = import.meta.glob<string>('./validators.js', { eager: true, query: '?raw', import: 'default' })['./validators.js']!

  it('без импортов и require', () => {
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/require\(/)
  })

  it('проверка длины строк (ucs2length) работает', () => {
    const p = { schemaVersion: 1, slug: 'x', title: '', status: 'idea', createdAt: '2026-09-23T01:00:00+03:00', updatedAt: '2026-09-23T01:00:00+03:00' }
    expect(validateProject(p)).toBe(false)
    expect(validateProject({ ...p, title: 'Икс' })).toBe(true)
  })
})
