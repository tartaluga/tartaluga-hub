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
    expect(html).toContain('появится с виджетами')
    expect(html).toContain('Проект b')
    expect(html).toContain('01.09')
    expect(html).not.toContain('Проектов пока нет.')
  })

  it('период из адреса; незнакомый — квартал', () => {
    expect(render('/stats?period=month')).toContain('23.08 — 23.09.2026')
    expect(render('/stats?period=half')).toMatch(/aria-pressed="true"[^>]*>Полгода/)
    expect(render('/stats?period=year')).toContain('23.06 — 23.09.2026')
  })
})
