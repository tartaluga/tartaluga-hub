import { describe, expect, it } from 'vitest'
import { newProjectDraft, projectPaths, takenSlugs } from './newProject'

const NOW = new Date(2026, 8, 23, 14, 32, 0)
const input = (over: object = {}) => ({ title: 'Бот расписания', status: 'active' as const, nextStep: '', ...over })

describe('newProjectDraft', () => {
  it('slug из названия, файл проходит схему, пустой шаг не пишется', () => {
    const d = newProjectDraft(input(), [], NOW)
    if (!d.ok) throw new Error(d.error)
    expect(d.slug).toBe('bot-raspisaniya')
    expect(d.path).toBe('projects/bot-raspisaniya.json')
    const data = JSON.parse(d.text)
    expect(data).toMatchObject({ schemaVersion: 1, slug: 'bot-raspisaniya', title: 'Бот расписания', status: 'active' })
    expect(data).not.toHaveProperty('nextStep')
    expect(data.createdAt).toBe(data.updatedAt)
  })

  it('занятый slug — следующий свободный', () => {
    const d = newProjectDraft(input(), ['bot-raspisaniya', 'bot-raspisaniya-2'], NOW)
    expect(d).toMatchObject({ ok: true, slug: 'bot-raspisaniya-3' })
  })

  it('один и тот же ввод в один момент — один и тот же текст (повтор создания не плодит дубли)', () => {
    expect(newProjectDraft(input(), [], NOW)).toEqual(newProjectDraft(input(), [], NOW))
  })

  it('пробелы по краям и внутри схлопываются; пустое и слишком длинное не проходят', () => {
    const d = newProjectDraft(input({ title: '  Бот   расписания ', nextStep: ' Починить  парсер ' }), [], NOW)
    if (!d.ok) throw new Error(d.error)
    expect(JSON.parse(d.text)).toMatchObject({ title: 'Бот расписания', nextStep: 'Починить парсер' })
    expect(newProjectDraft(input({ title: '   ' }), [], NOW)).toMatchObject({ ok: false })
    expect(newProjectDraft(input({ title: 'x'.repeat(121) }), [], NOW)).toMatchObject({ ok: false })
    expect(newProjectDraft(input({ nextStep: 'x'.repeat(201) }), [], NOW)).toMatchObject({ ok: false })
  })
})

describe('takenSlugs и projectPaths', () => {
  it('занятыми считаются все файлы проектов, даже нечитаемые; другие пути — нет', () => {
    expect(takenSlugs(['projects/a.json', 'projects/broken.json', 'ideas/x.json', 'covers/c.webp'])).toEqual(['a', 'broken'])
  })

  it('с проектом удаляются только его файл и его обложки, чужие — нет', () => {
    const tree = ['projects/a.json', 'covers/a.webp', 'covers/a.jpg', 'covers/a-b.webp', 'projects/a-b.json', 'covers/b.webp']
    expect(projectPaths('a', tree)).toEqual(['projects/a.json', 'covers/a.webp', 'covers/a.jpg'])
  })
})
