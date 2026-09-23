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

describe('JSON Schema v1: примеры', () => {
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
