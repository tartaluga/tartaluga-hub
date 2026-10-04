import { describe, expect, it } from 'vitest'
import { validateProject } from '../schema/validators.js'
import { merge, type JsonObject } from './merge'
import { parseFile, serialize } from './model'
import { projectPaths } from './newProject'
import { normalizeProject } from './normalize'

const T1 = '01K5TQ0000000000000000C001'
const T2 = '01K5TQ0000000000000000C002'
const L1 = '01K5TQ0000000000000000A001'
const K1 = '01K5TQ0000000000000000E001'
const AT = '2026-10-04T10:00:00+03:00'
const NOW = '2026-10-04T12:00:00+03:00'

const proj = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  slug: 'x',
  title: 'Икс',
  status: 'active',
  createdAt: AT,
  updatedAt: AT,
  ...extra,
})
const task = (extra: Record<string, unknown> = {}) => ({ id: T1, title: 'т', done: false, ...extra })
const withTask = (extra: Record<string, unknown>) => proj({ tasks: [task(extra)] })
const ok = (d: unknown) => validateProject(d) === true

describe('схема ADR-016: границы', () => {
  it('banner: webp, jpg и null проходят; png, covers/, вложенный путь, пустая строка, не строка — нет', () => {
    for (const b of ['banners/x.webp', 'banners/x.jpg', null]) expect(ok(proj({ banner: b }))).toBe(true)
    for (const b of ['banners/x.png', 'covers/x.webp', 'banners/a/x.webp', 'banners/X.webp', 'banners/.webp', '', '/banners/x.webp', 'banners/x.webp\n', 5]) {
      expect(ok(proj({ banner: b })), String(b)).toBe(false)
    }
  })

  it('inProgress: только true', () => {
    expect(ok(withTask({ inProgress: true }))).toBe(true)
    for (const v of [false, 'true', 1, null]) expect(ok(withTask({ inProgress: v }))).toBe(false)
  })

  it('cancelled: только true', () => {
    expect(ok(withTask({ done: true, cancelled: true }))).toBe(true)
    for (const v of [false, 'true', 1, null]) expect(ok(withTask({ done: true, cancelled: v }))).toBe(false)
  })

  it('description: ровно 10000 символов проходит, 10001 нет; не строка нет', () => {
    expect(ok(withTask({ description: 'я'.repeat(10000) }))).toBe(true)
    expect(ok(withTask({ description: 'я'.repeat(10001) }))).toBe(false)
    expect(ok(withTask({ description: 5 }))).toBe(false)
  })

  const cm = (extra: Record<string, unknown> = {}) => ({ id: K1, at: AT, text: 'привет', ...extra })
  it('comments: обязательные id, at, text', () => {
    expect(ok(withTask({ comments: [cm()] }))).toBe(true)
    for (const k of ['id', 'at', 'text']) {
      const c: Record<string, unknown> = cm()
      delete c[k]
      expect(ok(withTask({ comments: [c] })), k).toBe(false)
    }
  })
  it('comments: text 2000 проходит, 2001 нет; пустой и из пробелов нет', () => {
    expect(ok(withTask({ comments: [cm({ text: 'x'.repeat(2000) })] }))).toBe(true)
    expect(ok(withTask({ comments: [cm({ text: 'x'.repeat(2001) })] }))).toBe(false)
    for (const t of ['', '   ', '\n\t']) expect(ok(withTask({ comments: [cm({ text: t })] }))).toBe(false)
  })
  it('comments: author — открытый список, но по шаблону; at/editedAt — дата со временем', () => {
    for (const a of ['claude', 'bot-2']) expect(ok(withTask({ comments: [cm({ author: a })] }))).toBe(true)
    for (const a of ['Claude', '', '1x', 'a b', 5]) expect(ok(withTask({ comments: [cm({ author: a })] }))).toBe(false)
    expect(ok(withTask({ comments: [cm({ editedAt: AT })] }))).toBe(true)
    expect(ok(withTask({ comments: [cm({ editedAt: 'вчера' })] }))).toBe(false)
    expect(ok(withTask({ comments: [cm({ at: '2026-10-04' })] }))).toBe(false)
    expect(ok(withTask({ comments: [cm({ id: 'не-ulid' })] }))).toBe(false)
  })
  it('comments: не массив — нет; незнакомые поля комментария и задачи проверку проходят', () => {
    expect(ok(withTask({ comments: {} }))).toBe(false)
    expect(ok(withTask({ comments: [cm({ future: 1 })], futureTask: [1] }))).toBe(true)
  })

  it('ссылки задачи: javascript:, data:, пустой value, ftp для site — нет; https и vscode для other — да', () => {
    const lk = (kind: string, value: string, id = L1) => ({ id, kind, value })
    expect(ok(withTask({ links: [lk('doc', 'https://e.com/')] }))).toBe(true)
    expect(ok(withTask({ links: [lk('other', 'vscode://file/x')] }))).toBe(true)
    const bad: [string, string][] = [
      ['doc', 'javascript:alert(1)'],
      ['site', 'data:text/html,x'],
      ['local', 'ftp://x'],
      ['doc', ''],
      ['doc', ' https://x'],
      ['repo', 'a b'],
    ]
    for (const [k, v] of bad) expect(ok(withTask({ links: [lk(k, v)] })), `${k} ${v}`).toBe(false)
    expect(ok(withTask({ links: [{ kind: 'doc', value: 'https://e.com/' }] }))).toBe(false)
  })

  it('log.taskId: строка проходит (даже несуществующая), не строка нет', () => {
    const entry = (extra: Record<string, unknown>) => proj({ log: [{ id: L1, at: AT, kind: 'task', text: 'т', ...extra }] })
    expect(ok(entry({ taskId: T1 }))).toBe(true)
    expect(ok(entry({ taskId: 'нет-такой' }))).toBe(true)
    expect(ok(entry({ taskId: 5 }))).toBe(false)
  })

  it('обе метки сразу схема не запрещает (чистит normalizeProject)', () => {
    expect(ok(withTask({ done: true, inProgress: true, cancelled: true }))).toBe(true)
  })
})

describe('parseFile: вложенные id (ADR-016)', () => {
  const read = (o: unknown) => parseFile('projects/x.json', 'sha', JSON.stringify(o))
  const tasks = (p: ReturnType<typeof read>) => (p as unknown as { data: { tasks: Record<string, unknown>[] } }).data.tasks

  it('второй разбор после присвоения id ничего не меняет, id стабильны через serialize', () => {
    const first = read(withTask({ links: [{ kind: 'doc', value: 'https://e.com/' }], comments: [{ at: AT, text: 'a' }] }))
    expect(first).toMatchObject({ ok: true, idsAssigned: true })
    const second = parseFile('projects/x.json', 'sha', serialize((first as unknown as { data: never }).data))
    expect(second).toMatchObject({ ok: true, idsAssigned: false })
    expect(tasks(second)[0]).toEqual(tasks(first)[0])
  })

  it('id присваиваются каждому элементу, все разные, существующие не трогаются', () => {
    const p = read(withTask({ links: [{ id: L1, kind: 'doc', value: 'https://a/' }, { kind: 'doc', value: 'https://b/' }, { kind: 'doc', value: 'https://c/' }] }))
    const ids = (tasks(p)[0]!.links as { id: string }[]).map((l) => l.id)
    expect(ids[0]).toBe(L1)
    expect(new Set(ids).size).toBe(3)
  })

  it('две задачи: повтор id между вложенными массивами разных задач допустим', () => {
    const p = read(proj({ tasks: [task({ links: [{ id: L1, kind: 'doc', value: 'https://a/' }] }), task({ id: T2, comments: [{ id: L1, at: AT, text: 'a' }] })] }))
    expect(p).toMatchObject({ ok: true, idsAssigned: false })
  })

  it('повтор id задач сообщается по tasks, вложенный повтор — с id задачи в метке', () => {
    expect(read(proj({ tasks: [task(), task()] }))).toMatchObject({ ok: false, error: expect.stringContaining('tasks с id') })
    const r = read(proj({ tasks: [task({ links: [{ id: L1, kind: 'doc', value: 'https://a/' }, { id: L1, kind: 'doc', value: 'https://b/' }] }), task({ id: T2 })] }))
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(`tasks[${T1}].links`) })
  })

  it('незнакомые поля вложенных ссылок и комментариев сохраняются при присвоении id', () => {
    const p = read(withTask({ links: [{ kind: 'doc', value: 'https://a/', future: { a: 1 } }], comments: [{ at: AT, text: 'a', mood: 'x' }] }))
    const t = tasks(p)[0]!
    expect((t.links as Record<string, unknown>[])[0]).toMatchObject({ future: { a: 1 } })
    expect((t.comments as Record<string, unknown>[])[0]).toMatchObject({ mood: 'x' })
  })
})

describe('merge: подробности задачи', () => {
  const A = '01K5Z0000000000000000000AA'
  const mk = (t: Record<string, unknown>): JsonObject =>
    ({ schemaVersion: 2, slug: 'x', title: 'X', status: 'active', tasks: [{ id: A, title: 'a', done: false, ...t }], createdAt: AT, updatedAt: AT }) as JsonObject
  const first = (r: { merged: JsonObject }) => (r.merged.tasks as JsonObject[])[0]!

  it('удаление ссылки с одной стороны при правке другой ссылки — без конфликта', () => {
    const l = (id: string, v: string) => ({ id, kind: 'doc', value: v })
    const base = mk({ links: [l('L1', 'https://a/'), l('L2', 'https://b/')] })
    const r = merge('project', base, mk({ links: [l('L2', 'https://b/')] }), mk({ links: [l('L1', 'https://a/'), l('L2', 'https://b2/')] }))
    expect(r.conflicts).toEqual([])
    expect(first(r).links).toEqual([l('L2', 'https://b2/')])
  })

  it('description добавлено с обеих сторон одинаковым — без конфликта; разным — конфликт', () => {
    expect(merge('project', mk({}), mk({ description: 'да' }), mk({ description: 'да' })).conflicts).toEqual([])
    expect(merge('project', mk({}), mk({ description: 'а' }), mk({ description: 'б' })).conflicts).toHaveLength(1)
  })

  it('незнакомые поля задачи и комментария выживают слияние', () => {
    const c = { id: 'K1', at: AT, text: 'a', mood: 'x' }
    const base = mk({ comments: [c], future: 1 })
    const r = merge('project', base, mk({ comments: [c], future: 1, description: 'мой' }), base)
    expect(first(r)).toMatchObject({ future: 1, description: 'мой' })
    expect((first(r).comments as JsonObject[])[0]).toEqual(c)
  })
})

describe('normalizeProject: метки (ADR-016), граничные', () => {
  const run = (tasks: Record<string, unknown>[]) => (normalizeProject(undefined, proj({ tasks }) as never, NOW) as unknown as { tasks: Record<string, unknown>[] }).tasks

  it('пустой список задач и проект без tasks не падают', () => {
    expect(run([])).toEqual([])
    expect(() => normalizeProject(undefined, proj() as never, NOW)).not.toThrow()
  })

  it('обе метки при done=true: остаётся cancelled; при done=false: остаётся inProgress', () => {
    const [a, b] = run([task({ done: true, inProgress: true, cancelled: true }), task({ id: T2, inProgress: true, cancelled: true })])
    expect(a).toEqual({ id: T1, title: 'т', done: true, cancelled: true })
    expect(b).toEqual({ id: T2, title: 'т', done: false, inProgress: true })
  })

  it('задача без меток возвращается тем же объектом', () => {
    const t = task()
    const out = normalizeProject(undefined, proj({ tasks: [t] }) as never, NOW) as unknown as { tasks: unknown[] }
    expect(out.tasks[0]).toBe(t)
  })

  it('done=false с cancelled:false (мусор) метку убирает', () => {
    expect(run([task({ cancelled: false })])[0]).not.toHaveProperty('cancelled')
  })

  it('done не boolean (мусор): ни inProgress, ни cancelled не трогаются', () => {
    const [a] = run([task({ done: 'да', inProgress: true, cancelled: true })])
    expect(a).toMatchObject({ inProgress: true, cancelled: true })
  })

  it('шапка и незнакомые поля проекта не трогаются', () => {
    const out = normalizeProject(undefined, proj({ banner: 'banners/x.webp', future: 1 }) as never, NOW) as unknown as Record<string, unknown>
    expect(out).toMatchObject({ banner: 'banners/x.webp', future: 1, schemaVersion: 2 })
  })
})

describe('projectPaths: шапки', () => {
  it('пустое дерево и дерево без файлов проекта', () => {
    expect(projectPaths('a', [])).toEqual([])
    expect(projectPaths('a', ['projects/b.json', 'banners/b.jpg'])).toEqual([])
  })
  it('только точные пути: двойник с префиксом, другой тип и вложенность не попадают', () => {
    const tree = ['projects/a.json', 'banners/a.webp', 'banners/a.jpg', 'banners/a.png', 'banners/ab.webp', 'banners/a/x.webp', 'banners/a.webp.bak', 'covers/a.jpg', 'x/banners/a.webp']
    expect(projectPaths('a', tree)).toEqual(['projects/a.json', 'banners/a.webp', 'banners/a.jpg', 'covers/a.jpg'])
  })
  it('slug со спецсимволами не работает как шаблон', () => {
    expect(projectPaths('a.', ['banners/ab.webp', 'projects/ab.json'])).toEqual([])
  })
})
