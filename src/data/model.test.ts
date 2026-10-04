import { describe, expect, it } from 'vitest'
import { firstDue, nowIso, parseFile, parseLocalDate, SCHEMA_VERSIONS, serialize, slugify, uniqueSlug } from './model'
import type { Project } from '../schema/types'

const project = (extra: object = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    slug: 'x',
    title: 'Икс',
    status: 'active',
    createdAt: '2026-09-23T01:00:00+03:00',
    updatedAt: '2026-09-23T01:00:00+03:00',
    ...extra,
  })

describe('parseFile', () => {
  it('корректный проект', () => {
    const p = parseFile('projects/x.json', 'sha', project())
    expect(p).toMatchObject({ ok: true, kind: 'project', readOnly: false })
  })

  it('незнакомые поля сохраняются при чтении и записи', () => {
    const p = parseFile('projects/x.json', 'sha', project({ fromTheFuture: { a: [1] } }))
    if (!p.ok) throw new Error(p.error)
    const edited = { ...p.data, title: 'Новое' }
    expect(JSON.parse(serialize(edited)).fromTheFuture).toEqual({ a: [1] })
  })

  it('битый JSON — понятная ошибка, а не падение', () => {
    expect(parseFile('projects/x.json', 'sha', '{ "slug": ')).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/) })
  })

  it('нарушение схемы — ошибка с путём к полю', () => {
    const p = parseFile('projects/x.json', 'sha', project({ status: 'wip' }))
    expect(p).toMatchObject({ ok: false, error: expect.stringContaining('/status') })
  })

  it.each(['links', 'milestones', 'tasks', 'log'])('два элемента %s с одним id — ошибка', (key) => {
    const item: Record<string, object> = {
      links: { kind: 'site', value: 'https://example.com/' },
      milestones: { title: 'Веха' },
      tasks: { title: 'Задача', done: false },
      log: { at: '2026-09-23T02:30:00+03:00', kind: 'note', text: 'Запись' },
    }
    const id = '01K5TQ0000000000000000Z001'
    const one = { id, ...item[key] }
    expect(parseFile('projects/x.json', 'sha', project({ [key]: [one] }))).toMatchObject({ ok: true })
    const p = parseFile('projects/x.json', 'sha', project({ [key]: [one, { ...item[key], id: '01K5TQ0000000000000000Z002' }, one] }))
    expect(p).toMatchObject({ ok: false, error: `два элемента ${key} с id «${id}»` })
  })

  it('элементы без id не считаются повтором: им выдаются разные id', () => {
    const p = parseFile('projects/x.json', 'sha', project({ tasks: [{ title: 'А', done: false }, { title: 'Б', done: false }] }))
    expect(p).toMatchObject({ ok: true, idsAssigned: true })
  })

  it('два тега с одним id в settings.json — ошибка', () => {
    const tag = { id: 'code', name: 'код', color: '#a7a1db' }
    const text = (tags: object[]) => JSON.stringify({ schemaVersion: 1, tags })
    expect(parseFile('settings.json', 'sha', text([tag, { ...tag, id: 'study' }]))).toMatchObject({ ok: true })
    expect(parseFile('settings.json', 'sha', text([tag, { ...tag, name: 'ещё' }]))).toMatchObject({ ok: false, error: 'два элемента tags с id «code»' })
  })

  it('slug не совпадает с именем файла — ошибка', () => {
    expect(parseFile('projects/y.json', 'sha', project())).toMatchObject({ ok: false, error: expect.stringContaining('slug') })
  })

  it('версии по видам: проект v2, идея и настройки v1 (ADR-009)', () => {
    expect(SCHEMA_VERSIONS).toEqual({ project: 2, idea: 1, settings: 1 })
  })

  it('проект v1 читается и правится', () => {
    expect(parseFile('projects/x.json', 'sha', project({ schemaVersion: 1 }))).toMatchObject({ ok: true, readOnly: false })
  })

  it('проект v2 с новыми полями читается и правится', () => {
    const p = parseFile(
      'projects/x.json',
      'sha',
      project({
        schemaVersion: 2,
        status: 'done',
        doneAt: '2026-09-24T10:00:00+03:00',
        fromIdea: { ideaId: '01K5TQ0000000000000000E001', text: 'идея', createdAt: '2026-09-20T10:00:00+03:00' },
        tasks: [{ id: '01K5TQ0000000000000000C001', title: 'т', done: false, due: '2026-10-02', originalDue: '2026-10-01' }],
      }),
    )
    expect(p).toMatchObject({ ok: true, readOnly: false })
  })

  it('проект v3 — только чтение с понятной причиной', () => {
    const p = parseFile('projects/x.json', 'sha', project({ schemaVersion: 3 }))
    expect(p).toMatchObject({ ok: true, readOnly: true, reason: expect.stringContaining('v3') })
    if (!p.ok || !p.readOnly) throw new Error('ожидалось только чтение')
    expect(p.reason).toContain('проектов только до v2')
  })

  it('идея и настройки v2 — только чтение: для них знакома только v1', () => {
    const idea = JSON.stringify({ schemaVersion: 2, id: '01K5TQ0000000000000000E001', text: 'т', createdAt: '2026-09-23T01:00:00Z' })
    const pi = parseFile('ideas/01K5TQ0000000000000000E001.json', 's', idea)
    expect(pi).toMatchObject({ ok: true, readOnly: true, reason: expect.stringContaining('идей только до v1') })
    const ps = parseFile('settings.json', 's', JSON.stringify({ schemaVersion: 2, tags: [] }))
    expect(ps).toMatchObject({ ok: true, readOnly: true, reason: expect.stringContaining('настроек только до v1') })
  })

  it('чтение v1 файл не переписывает: ни originalDue, ни версии', () => {
    const task = { id: '01K5TQ0000000000000000C001', title: 'т', done: false, due: '2026-10-01' }
    const p = parseFile('projects/x.json', 'sha', project({ tasks: [task] }))
    if (!p.ok) throw new Error(p.error)
    expect(p.data.schemaVersion).toBe(1)
    expect(p.data.tasks).toEqual([task])
  })

  it('задачи без id (ручная правка) получают id и помечаются', () => {
    const p = parseFile('projects/x.json', 'sha', project({ tasks: [{ title: 'руками', done: false }] }))
    if (!p.ok) throw new Error(p.error)
    expect(p.idsAssigned).toBe(true)
    expect((p.data as Project).tasks?.[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('идея: id должен совпадать с именем файла', () => {
    const idea = JSON.stringify({ schemaVersion: 1, id: '01K5TQ0000000000000000E001', text: 'т', createdAt: '2026-09-23T01:00:00Z' })
    expect(parseFile('ideas/01K5TQ0000000000000000E001.json', 's', idea)).toMatchObject({ ok: true })
    expect(parseFile('ideas/OTHER.json', 's', idea)).toMatchObject({ ok: false })
  })
})

describe('даты', () => {
  it('nowIso даёт время с локальным смещением и проходит схему', () => {
    expect(nowIso(new Date(2026, 8, 23, 3, 4, 5))).toMatch(/^2026-09-23T03:04:05[+-]\d{2}:\d{2}$/)
  })

  it('дедлайн разбирается как местная дата, без сдвига часового пояса', () => {
    const d = parseLocalDate('2026-09-23')
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 23, 0])
  })
})

describe('slug', () => {
  it.each([
    ['Tartaluga Hub', 'tartaluga-hub'],
    ['Бот расписания', 'bot-raspisaniya'],
    ['Щука и ёж!!', 'schuka-i-ezh'],
    ['  --  ', 'project'],
    ['Сайт v2.0', 'sayt-v2-0'],
  ])('%s → %s', (title, slug) => {
    expect(slugify(title)).toBe(slug)
  })

  it('занятый slug получает номер', () => {
    expect(uniqueSlug('Бот', ['bot', 'bot-2'])).toBe('bot-3')
  })
})

describe('firstDue', () => {
  it('originalDue, если есть', () => {
    expect(firstDue({ due: '2026-10-05', originalDue: '2026-10-01' })).toBe('2026-10-01')
  })
  it('без originalDue (v1, скилл, ручная правка) — due', () => {
    expect(firstDue({ due: '2026-10-05' })).toBe('2026-10-05')
  })
  it('без срока — нет первого срока', () => {
    expect(firstDue({})).toBeUndefined()
  })
})

describe('вложенные id-массивы задач (ADR-016)', () => {
  const T1 = '01K5TQ0000000000000000C001'
  const T2 = '01K5TQ0000000000000000C002'
  const L1 = '01K5TQ0000000000000000A001'
  const L2 = '01K5TQ0000000000000000A002'
  const link = (extra: object = {}) => ({ kind: 'doc', value: 'https://example.com/', ...extra })
  const comment = (extra: object = {}) => ({ at: '2026-10-04T10:00:00+03:00', text: 'привет', ...extra })
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
  const read = (text: string) => {
    const p = parseFile('projects/x.json', 'sha', text)
    if (!p.ok) throw new Error(p.error)
    return p
  }
  const tasksOf = (p: ReturnType<typeof read>) => (p.data as Project).tasks as unknown as Record<string, unknown>[]

  it('ссылка и комментарий задачи без id получают id, проект открывается, idsAssigned = true', () => {
    const p = read(project({ tasks: [{ id: T1, title: 'т', done: false, links: [link()], comments: [comment()] }] }))
    expect(p.idsAssigned).toBe(true)
    const t = tasksOf(p)[0]!
    expect((t.links as { id: string }[])[0]!.id).toMatch(ULID)
    expect((t.comments as { id: string }[])[0]!.id).toMatch(ULID)
  })

  it('задача без id со ссылками без id: получают id и задача, и ссылки', () => {
    const p = read(project({ tasks: [{ title: 'т', done: false, links: [link(), link()] }] }))
    expect(p.idsAssigned).toBe(true)
    const t = tasksOf(p)[0]!
    expect(t.id).toMatch(ULID)
    const ids = (t.links as { id: string }[]).map((l) => l.id)
    expect(ids[0]).toMatch(ULID)
    expect(new Set(ids).size).toBe(2)
  })

  it('все id на месте — idsAssigned = false', () => {
    const p = read(project({ tasks: [{ id: T1, title: 'т', done: false, links: [link({ id: L1 })], comments: [comment({ id: L2 })] }] }))
    expect(p.idsAssigned).toBe(false)
  })

  it('повтор id в tasks[i].links — ошибка с путём; в comments — тоже', () => {
    const dup = parseFile('projects/x.json', 'sha', project({ tasks: [{ id: T1, title: 'т', done: false, links: [link({ id: L1 }), link({ id: L1 })] }] }))
    expect(dup).toMatchObject({ ok: false, error: `два элемента tasks[${T1}].links с id «${L1}»` })
    const dupC = parseFile('projects/x.json', 'sha', project({ tasks: [{ id: T1, title: 'т', done: false, comments: [comment({ id: L1 }), comment({ id: L1 })] }] }))
    expect(dupC).toMatchObject({ ok: false, error: `два элемента tasks[${T1}].comments с id «${L1}»` })
  })

  it('одинаковый id у ссылок разных задач и у ссылки задачи и ссылки проекта — не ошибка', () => {
    const p = parseFile(
      'projects/x.json',
      'sha',
      project({
        links: [link({ id: L1 })],
        tasks: [
          { id: T1, title: 'а', done: false, links: [link({ id: L1 })] },
          { id: T2, title: 'б', done: false, links: [link({ id: L1 })] },
        ],
      }),
    )
    expect(p).toMatchObject({ ok: true, idsAssigned: false })
  })

  it('ссылка задачи с javascript: не проходит схему (kind doc), комментарий длиннее 2000 — тоже', () => {
    const bad = parseFile('projects/x.json', 'sha', project({ tasks: [{ id: T1, title: 'т', done: false, links: [link({ id: L1, value: 'javascript:alert(1)' })] }] }))
    expect(bad).toMatchObject({ ok: false })
    const long = parseFile('projects/x.json', 'sha', project({ tasks: [{ id: T1, title: 'т', done: false, comments: [comment({ id: L1, text: 'x'.repeat(2001) })] }] }))
    expect(long).toMatchObject({ ok: false })
  })

  it('мусор вместо задачи или массива не роняет разбор', () => {
    expect(parseFile('projects/x.json', 'sha', project({ tasks: [null, 'x', { id: T1, title: 'т', done: false, links: 'нет' }] }))).toMatchObject({ ok: false })
  })
})

describe('предел размера файла (ADR-016)', () => {
  it('5 МБ — в байтах UTF-8, а не в символах', async () => {
    const { FILE_BYTES_LIMIT, fitsFileLimit } = await import('./model')
    expect(FILE_BYTES_LIMIT).toBe(5 * 1024 * 1024)
    expect(fitsFileLimit('x'.repeat(FILE_BYTES_LIMIT))).toBe(true)
    expect(fitsFileLimit('x'.repeat(FILE_BYTES_LIMIT + 1))).toBe(false)
    // «я» — 2 байта: половина предела в символах уже не влезает.
    expect(fitsFileLimit('я'.repeat(FILE_BYTES_LIMIT / 2))).toBe(true)
    expect(fitsFileLimit('я'.repeat(FILE_BYTES_LIMIT / 2 + 1))).toBe(false)
  })
})
