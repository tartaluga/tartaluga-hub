import { describe, expect, it } from 'vitest'
import { nowIso, parseFile, parseLocalDate, serialize, slugify, uniqueSlug } from './model'
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

  it('slug не совпадает с именем файла — ошибка', () => {
    expect(parseFile('projects/y.json', 'sha', project())).toMatchObject({ ok: false, error: expect.stringContaining('slug') })
  })

  it('версия формата выше нашей — только чтение', () => {
    const p = parseFile('projects/x.json', 'sha', project({ schemaVersion: 2 }))
    expect(p).toMatchObject({ ok: true, readOnly: true, reason: expect.stringContaining('v2') })
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
