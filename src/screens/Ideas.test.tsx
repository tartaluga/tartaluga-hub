// @vitest-environment happy-dom
import { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Ideas, ideasEyebrow } from './Ideas'

// Серверный рендер zustand берёт начальное состояние стора, поэтому стор подменяем простым объектом.
const mockState = vi.hoisted(() => ({ files: [] as { path: string; sha: string; text: string }[], branch: 'main', tree: null }))
const listeners = vi.hoisted(() => new Set<() => void>())
vi.mock('../app/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../app/session')>()
  const useSession = Object.assign(
    (sel: (s: typeof mockState) => unknown) =>
      useSyncExternalStore(
        (l) => (listeners.add(l), () => void listeners.delete(l)),
        () => sel(mockState),
        () => sel(mockState),
      ),
    { getState: () => mockState },
  )
  return { ...real, useSession }
})
vi.mock('../data/ideas', async (importOriginal) => {
  const real = await importOriginal<typeof import('../data/ideas')>()
  return {
    ...real,
    // Как настоящая: неотправленная идея убрана с экрана, а сверка не удалась.
    deleteIdea: vi.fn(async (id: string) => {
      mockState.files = mockState.files.filter((f) => f.path !== `ideas/${id}.json`)
      listeners.forEach((l) => l())
      throw new (await import('../lib/api')).ApiError(0, 'local_only', real.DELETED_ONLY_ON_DEVICE)
    }),
  }
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

  it('ошибка удаления неотправленной идеи видна в уведомлении экрана, когда строки уже нет', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const id = '01J8Z6Y0000000000000000009'
    mockState.files = [idea(id, { text: 'Летучая идея' })]
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/ideas']}>
          <Ideas />
        </MemoryRouter>,
      ),
    )
    const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
    await act(async () => button('Летучая идея').click())
    await act(async () => button('Удалить').click())
    await act(async () => button('Удалить идею').click())
    await act(async () => {})
    expect(host.textContent).not.toContain('Летучая идея')
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Идея удалена только с устройства')
    await act(async () => alert.querySelector<HTMLButtonElement>('button[aria-label="Закрыть уведомление"]')!.click())
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })
})
