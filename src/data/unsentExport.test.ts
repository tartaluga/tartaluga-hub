import { describe, expect, it } from 'vitest'
import type { QueuedEdit, StoredConflict } from '../lib/localdb'
import { buildUnsentExport, hasUnsent, UNSENT_FORMAT, unsentFileName } from './unsentExport'

const edit = (branch: string, path: string, over: Partial<QueuedEdit> = {}): QueuedEdit => ({
  branch,
  path,
  baseSha: `sha-${branch}-${path}`,
  baseText: '{"title":"старое"}',
  patch: { title: 'Новое' },
  text: JSON.stringify({ slug: 'x', title: 'Новое' }),
  queuedAt: '2026-09-26T10:00:00.000Z',
  id: 'internal-id',
  ...over,
})

const conflict: StoredConflict = {
  branch: 'main',
  path: 'projects/bot.json',
  title: 'Бот',
  at: '2026-09-26T11:00:00.000Z',
  items: [
    { kind: 'field', path: ['nextStep'], base: 'шаг', local: 'мой шаг', remote: undefined },
    { kind: 'element', path: ['tasks', '01K5Y0000000000000000000AA'], deletedBy: 'remote', base: { t: 1 }, local: { t: 2 }, remote: undefined },
  ],
  labels: ['следующий шаг'],
  refused: { reason: 'не слилось', mine: '{"title":"моя"}' },
  deleted: { mine: 'не JSON' },
}

const NOW = new Date(2026, 8, 26, 14, 5)

describe('buildUnsentExport', () => {
  it('правки всех веток по порядку: ветка, путь, время, моя версия файла и правка', () => {
    const out = buildUnsentExport([edit('work', 'projects/b.json'), edit('main', 'projects/z.json'), edit('main', 'projects/a.json')], [], NOW)
    expect(out.format).toBe(UNSENT_FORMAT)
    expect(out.formatVersion).toBe(1)
    expect(out.exportedAt).toBe(NOW.toISOString())
    expect(out.edits.map((e) => `${e.branch}:${e.path}`)).toEqual(['main:projects/a.json', 'main:projects/z.json', 'work:projects/b.json'])
    expect(out.edits[0]).toEqual({
      branch: 'main',
      path: 'projects/a.json',
      queuedAt: '2026-09-26T10:00:00.000Z',
      baseSha: 'sha-main-projects/a.json',
      content: { slug: 'x', title: 'Новое' },
      patch: { title: 'Новое' },
    })
  })

  it('только явные поля: без служебного id и базовой копии', () => {
    const text = JSON.stringify(buildUnsentExport([edit('main', 'projects/a.json')], [conflict], NOW))
    expect(text).not.toContain('internal-id')
    expect(text).not.toContain('старое')
    expect(text).not.toContain('baseText')
  })

  it('текст, который не разбирается как JSON, сохраняется как есть', () => {
    const out = buildUnsentExport([edit('main', 'projects/a.json', { text: '{битый' })], [], NOW)
    expect(out.edits[0]!.content).toBe('{битый')
  })

  it('конфликты: каждое место с моей и чужой версией, «нет значения» — null; отказ и удаление — с моей версией файла', () => {
    const out = buildUnsentExport([], [conflict], NOW)
    const c = out.conflicts[0]!
    expect(c).toMatchObject({ branch: 'main', path: 'projects/bot.json', title: 'Бот', at: conflict.at })
    expect(c.places).toEqual([
      { label: 'следующий шаг', path: ['nextStep'], base: 'шаг', mine: 'мой шаг', theirs: null },
      { label: '', path: ['tasks', '01K5Y0000000000000000000AA'], base: { t: 1 }, mine: { t: 2 }, theirs: null },
    ])
    expect(c.refused).toEqual({ reason: 'не слилось', content: { title: 'моя' } })
    expect(c.deleted).toEqual({ content: 'не JSON' })
    // Без отказа и удаления полей нет вовсе.
    const plain = buildUnsentExport([], [{ ...conflict, refused: undefined, deleted: undefined }], NOW).conflicts[0]!
    expect(plain).not.toHaveProperty('refused')
    expect(plain).not.toHaveProperty('deleted')
  })

  it('результат переживает JSON без потерь', () => {
    const out = buildUnsentExport([edit('main', 'projects/a.json')], [conflict], NOW)
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('исходные массивы не меняются', () => {
    const edits = [edit('work', 'b'), edit('main', 'a')]
    buildUnsentExport(edits, [], NOW)
    expect(edits.map((e) => e.branch)).toEqual(['work', 'main'])
  })
})

describe('hasUnsent и имя файла', () => {
  it('есть что выгружать — правки или конфликты', () => {
    expect(hasUnsent({ edits: [], conflicts: [] })).toBe(false)
    expect(hasUnsent({ edits: [1], conflicts: [] })).toBe(true)
    expect(hasUnsent({ edits: [], conflicts: [1] })).toBe(true)
  })

  it('имя по местному времени', () => {
    expect(unsentFileName(NOW)).toBe('hub-unsent-2026-09-26-1405.json')
  })
})
