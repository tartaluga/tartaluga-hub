import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Stats } from './Stats'

// Серверный рендер zustand берёт начальное состояние стора, поэтому стор подменяем простым объектом.
const mockState = vi.hoisted(() => ({ files: [] as { path: string; sha: string; text: string }[], branch: 'main' }))
vi.mock('../app/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../app/session')>()
  const useSession = Object.assign((sel: (s: typeof mockState) => unknown) => sel(mockState), { getState: () => mockState })
  return { ...real, useSession }
})

const widgets = vi.hoisted(() => ({ status: null as unknown }))
vi.mock('../app/widgets', () => ({
  useWidgets: Object.assign((sel: (s: typeof widgets) => unknown) => sel(widgets), { getState: () => widgets }),
}))

const withStatus = (commitsByDay: Record<string, number>) => ({
  schemaVersion: 1,
  generatedAt: null,
  lastSuccess: null,
  errors: [],
  projects: { a: { repo: { fullName: 'me/a', commitsByDay } } },
})

const project = (slug: string, extra: object = {}) => ({
  path: `projects/${slug}.json`,
  sha: slug,
  text: JSON.stringify({
    schemaVersion: 2,
    slug,
    title: `Проект ${slug}`,
    status: 'active',
    createdAt: '2026-01-10T10:00:00+03:00',
    updatedAt: '2026-01-10T10:00:00+03:00',
    ...extra,
  }),
})

const render = (url = '/stats') =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Stats />
    </MemoryRouter>,
  )

describe('Stats', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 23, 14, 32))
    mockState.files = []
    mockState.branch = 'main'
    widgets.status = null
  })
  afterEach(() => vi.useRealTimers())

  it('без проектов — пустое состояние, период по умолчанию — квартал', () => {
    const html = render()
    expect(html).toContain('Проектов пока нет.')
    expect(html).toContain('23.06 — 23.09.2026')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Квартал/)
  })

  it('с данными: итоги, коммиты — пустое состояние, опубликованное', () => {
    mockState.files = [
      project('a', {
        log: [
          { id: '01JKKKKKKKKKKKKKKKKKKKKKK0', at: '2026-09-20T12:00:00+03:00', kind: 'done', text: 'x' },
          { id: '01JKKKKKKKKKKKKKKKKKKKKKK1', at: '2026-09-21T12:00:00+03:00', kind: 'done', text: 'y' },
        ],
      }),
      project('b', { status: 'done', doneAt: '2026-09-01T12:00:00+03:00' }),
    ]
    const html = render()
    expect(html).toContain('Записей в логе')
    expect(html).toContain('после первой проверки виджетов')
    expect(html).toContain('Пока только записи лога — коммиты появятся после первой проверки виджетов.')
    expect(html).toContain('Активность по проектам · записи лога')
    expect(html).toContain('Записи лога по дням')
    expect(html).toContain('Проект b')
    expect(html).toContain('01.09')
    expect(html).not.toContain('Проектов пока нет.')
  })

  it('со status: коммиты в плитке, пульсе и активности', () => {
    mockState.files = [project('a', { log: [{ id: '01JKKKKKKKKKKKKKKKKKKKKKK0', at: '2026-09-20T12:00:00+03:00', kind: 'done', text: 'x' }] })]
    widgets.status = withStatus({ '2026-09-21': 4, '2026-09-22': 3, '2026-01-01': 50 })
    const html = render()
    expect(html).toMatch(/Коммитов<\/dt><dd[^>]*>7</)
    expect(html).not.toContain('после первой проверки виджетов')
    expect(html).toContain('Активность по проектам · записи + коммиты')
    expect(html).toContain('Записи лога и коммиты по дням')
    expect(html).toContain('всего 8.')
    expect(html).toMatch(/Проект a[\s\S]*>8</)
  })

  it('со status, но без активности — пустое состояние про записи и коммиты', () => {
    mockState.files = [project('a')]
    widgets.status = withStatus({ '2026-01-01': 5 })
    const html = render()
    expect(html).toContain('За период нет записей и коммитов.')
    expect(html).toMatch(/Коммитов<\/dt><dd[^>]*>0</)
  })

  it('период из адреса; незнакомый — квартал', () => {
    expect(render('/stats?period=month')).toContain('23.08 — 23.09.2026')
    expect(render('/stats?period=half')).toMatch(/aria-pressed="true"[^>]*>Полгода/)
    expect(render('/stats?period=year')).toContain('23.06 — 23.09.2026')
  })
})
