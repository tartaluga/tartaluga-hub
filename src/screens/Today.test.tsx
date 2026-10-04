import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Today } from './Today'

// Серверный рендер zustand берёт начальное состояние стора, поэтому сторы подменяем простыми объектами.
const mockState = vi.hoisted(() => ({ files: [] as { path: string; sha: string; text: string }[], branch: 'main' }))
const widgets = vi.hoisted(() => ({ status: null as unknown, commits: new Map<string, number>() }))
vi.mock('../app/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../app/session')>()
  const useSession = Object.assign((sel: (s: typeof mockState) => unknown) => sel(mockState), { getState: () => mockState })
  return { ...real, useSession }
})
vi.mock('../app/widgets', async (importOriginal) => {
  const real = await importOriginal<typeof import('../app/widgets')>()
  const useWidgets = Object.assign((sel: (s: typeof widgets) => unknown) => sel(widgets), { getState: () => widgets })
  return { ...real, useWidgets }
})

const project = (slug: string) => ({
  path: `projects/${slug}.json`,
  sha: slug,
  text: JSON.stringify({
    schemaVersion: 2,
    slug,
    title: `Проект ${slug}`,
    status: 'active',
    createdAt: '2026-01-10T10:00:00+03:00',
    updatedAt: '2026-01-10T10:00:00+03:00',
    log: [{ id: '01J00000000000000000000001', at: new Date(2026, 8, 20, 12).toISOString(), kind: 'done', text: 'x' }],
  }),
})

const status = (commitsByDay: unknown) => ({
  schemaVersion: 1,
  generatedAt: '2026-09-23T10:00:00Z',
  lastSuccess: null,
  errors: [],
  projects: { a: { repo: { fullName: 'o/a', commitsByDay } } },
})

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Today />
    </MemoryRouter>,
  )

describe('Today: пульс', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 23, 14, 32))
    mockState.files = [project('a')]
    widgets.status = null
    widgets.commits = new Map()
  })
  afterEach(() => vi.useRealTimers())

  it('без status — только записи лога', () => {
    const html = render()
    expect(html).toContain('Записи лога по дням за 12 недель. 1 запись за сентябрь')
    expect(html).not.toContain('коммит')
  })

  it('со status — коммиты в подписи и в aria-label', () => {
    widgets.status = status({ '2026-09-22': 3, '2026-09-01': 2, '2026-08-30': 7, 'мусор': 5 })
    const html = render()
    expect(html).toContain('Записи лога и коммиты по дням за 12 недель. 1 запись и 5 коммитов за сентябрь')
    expect(html).toContain('<p class="_caption_')
    expect(html).toContain('1 запись и 5 коммитов за сентябрь</p>')
  })

  it('со status без коммитов в месяце — только записи; ничего нет — «записей и коммитов нет»', () => {
    widgets.status = status({ '2026-08-30': 7 })
    expect(render()).toContain('1 запись за сентябрь</p>')
    mockState.files = [{ ...project('a'), text: project('a').text.replace(/"log":\[.*\]/, '"log":[]') }]
    expect(render()).toContain('За сентябрь записей и коммитов нет</p>')
  })
})
