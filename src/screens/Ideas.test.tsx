import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Ideas, ideasEyebrow } from './Ideas'

// Серверный рендер zustand берёт начальное состояние стора, поэтому стор подменяем простым объектом.
const mockState = vi.hoisted(() => ({ files: [] as { path: string; sha: string; text: string }[], branch: 'main', tree: null }))
vi.mock('../app/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../app/session')>()
  const useSession = Object.assign((sel: (s: typeof mockState) => unknown) => sel(mockState), { getState: () => mockState })
  return { ...real, useSession }
})

const idea = (id: string, extra: object) => ({
  path: `ideas/${id}.json`,
  sha: `s${id}`,
  text: JSON.stringify({ schemaVersion: 1, id, text: 'Текст', createdAt: '2026-09-20T10:00:00+03:00', ...extra }),
})
const project = (slug: string, extra: object = {}) => ({
  path: `projects/${slug}.json`,
  sha: `s${slug}`,
  text: JSON.stringify({ schemaVersion: 2, slug, title: `Проект ${slug}`, status: 'active', createdAt: '2026-09-19T10:00:00+03:00', updatedAt: '2026-09-19T10:00:00+03:00', ...extra }),
})

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/ideas']}>
      <Ideas />
    </MemoryRouter>,
  )

beforeEach(() => {
  mockState.files = []
})

describe('Ideas', () => {
  it('ideasEyebrow склоняет и считает идеи без проекта', () => {
    expect(ideasEyebrow(0, 0)).toBe('0 идей')
    expect(ideasEyebrow(1, 1)).toBe('1 идея · 1 без проекта')
    expect(ideasEyebrow(7, 3)).toBe('7 идей · 3 без проекта')
  })

  it('пустой инбокс: подсказка про Enter и пустая колонка «Стали проектами»', () => {
    const html = render()
    expect(html).toContain('Новая идея… Enter — сохранить')
    expect(html).toContain('Идей пока нет')
    expect(html).toContain('Пока ни одна идея не стала проектом')
  })

  it('строки: дата, первая строка, проект, «проект удалён», «В проект»', () => {
    mockState.files = [
      idea('01J8Z6Y0000000000000000001', { text: 'Режим фокуса\nподробности', createdAt: '2026-09-23T10:00:00+03:00', project: 'hub' }),
      idea('01J8Z6Y0000000000000000002', { text: 'Светящиеся уши', createdAt: '2026-09-22T10:00:00+03:00' }),
      idea('01J8Z6Y0000000000000000003', { text: 'Сирота', project: 'gone' }),
      project('hub'),
    ]
    const html = render()
    expect(html).toContain('3 идеи · 1 без проекта')
    expect(html).toContain('23.09')
    expect(html).toContain('Режим фокуса')
    expect(html).not.toContain('подробности')
    expect(html).toContain('href="/projects/hub"')
    expect(html).toContain('Проект hub')
    expect(html).toContain('проект удалён')
    expect(html.match(/В проект/g)).toHaveLength(1)
    expect(html.indexOf('Режим фокуса')).toBeLessThan(html.indexOf('Светящиеся уши'))
  })

  it('«Стали проектами»: проект из идеи со ссылкой и текстом идеи', () => {
    mockState.files = [project('cafe', { title: 'Сайт кофейни', fromIdea: { ideaId: '01J8Z6Y0000000000000000009', text: 'Сайт для кофейни друга', createdAt: '2026-08-01T10:00:00+03:00' } })]
    const html = render()
    expect(html).toContain('Сайт кофейни')
    expect(html).toContain('из «Сайт для кофейни друга»')
    expect(html).toContain('19.09')
    expect(html).not.toContain('Пока ни одна идея не стала проектом')
  })

  it('битый файл идеи показан отдельно и не валит список', () => {
    mockState.files = [{ path: 'ideas/BAD.json', sha: 'x', text: '{' }, idea('01J8Z6Y0000000000000000001', { text: 'Живая' })]
    const html = render()
    expect(html).toContain('Живая')
    expect(html).toContain('ideas/BAD.json')
  })

  it('текст идеи — только текст: разметка не исполняется', () => {
    mockState.files = [idea('01J8Z6Y0000000000000000001', { text: '<img src=x onerror=alert(1)>' })]
    const html = render()
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
