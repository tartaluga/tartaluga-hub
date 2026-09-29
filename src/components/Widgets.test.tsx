// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWidgets, useWidgets } from '../app/widgets'
import { lastCommits } from '../data/widgets'
import type { Status } from '../schema/types'
import { ProjectWidgets, RefreshButton, TileWidgets, WidgetsNotice } from './Widgets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const H = 60 * 60 * 1000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

function status(extra: Partial<Status> = {}): Status {
  return {
    schemaVersion: 1,
    generatedAt: iso(H),
    lastSuccess: iso(H),
    errors: [],
    projects: {
      hub: {
        site: { url: 'https://hub.example/', state: 'up', httpStatus: 200, latency: 'fast', checkedAt: iso(H) },
        repo: {
          fullName: 'me/hub',
          defaultBranch: 'main',
          commits: [
            { sha: 'e5b0114aaaa', message: '<img src=x onerror=alert(1)>\nтело', date: iso(3 * H), url: 'https://github.com/me/hub/commit/e5b0114' },
            { sha: 'f00ba12', message: 'второй', date: iso(5 * H), url: 'javascript:alert(1)' },
          ],
          lastRun: { name: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/me/hub/actions/runs/1', at: iso(2 * H) },
          deployment: { environment: 'production', creator: 'netlify[bot]', state: 'success', url: 'https://hub.example/', at: iso(2 * H) },
        },
      },
      blocked: { site: { url: 'https://blocked.example', state: 'blocked', httpStatus: 403, latency: null, checkedAt: iso(H) } },
    },
    ...extra,
  }
}

function set(s: Status | null, extra: Partial<ReturnType<typeof useWidgets.getState>> = {}) {
  useWidgets.setState({ status: s, commits: lastCommits(s), empty: s === null, ...extra })
}

let root: Root
let host: HTMLElement

beforeEach(() => {
  resetWidgets()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const show = (el: React.ReactNode) => act(async () => root.render(el))
const text = () => host.textContent ?? ''

describe('плитка', () => {
  it('точка сайта и последний коммит', async () => {
    set(status())
    await show(<TileWidgets slug="hub" />)
    expect(text()).toContain('сайт')
    expect(text()).toContain('коммит 3 ч назад')
    expect(host.querySelector('[data-tone="ok"]')).not.toBeNull()
  })

  it('blocked — «не проверить», не «упал»; нет данных — ничего', async () => {
    set(status())
    await show(<TileWidgets slug="blocked" />)
    expect(text()).toBe('сайт не проверить')
    await show(<TileWidgets slug="nothing" />)
    expect(host.innerHTML).toBe('')
  })
})

describe('карточка', () => {
  it('сайт с кодом и задержкой, деплой по провайдеру, Actions, коммиты', async () => {
    set(status())
    await show(<ProjectWidgets slug="hub" />)
    const t = text()
    expect(t).toContain('hub.example')
    expect(t).toContain('работает')
    expect(t).toContain('200 · < 300 мс')
    expect(t).toContain('Netlify')
    expect(t).toContain('выложен')
    expect(t).toContain('CI')
    expect(t).toContain('упал')
    expect(t).toContain('e5b0114')
    expect(t).toContain('Коммиты · main')
  })

  it('сообщение коммита — только текст; ссылки — только http(s), наружу с noopener', async () => {
    set(status())
    await show(<ProjectWidgets slug="hub" />)
    expect(host.querySelector('img')).toBeNull()
    expect(text()).toContain('<img src=x onerror=alert(1)>')
    expect(text()).not.toContain('тело')
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://github.com/me/hub/commit/e5b0114')
    expect(hrefs.some((h) => h?.startsWith('javascript:'))).toBe(false)
    for (const a of host.querySelectorAll('a')) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    // Коммит с плохой ссылкой показан, но не ссылкой.
    expect(text()).toContain('f00ba12')
  })

  it('repo_not_accessible — «Добавь <repo> в токен статуса» со ссылкой на токены', async () => {
    set(status({ errors: [{ code: 'repo_not_accessible', message: 'Нет доступа', project: 'priv', repo: 'me/private' }] }))
    await show(<ProjectWidgets slug="priv" />)
    expect(text()).toContain('Добавь me/private в токен статуса')
    expect(host.querySelector('a[href="https://github.com/settings/personal-access-tokens"]')).not.toBeNull()
    expect(text()).not.toContain('Нечего проверять')
  })

  it('ещё не собирались — пустое состояние, не ошибка', async () => {
    set(null, { empty: true })
    await show(<ProjectWidgets slug="hub" />)
    expect(text()).toContain('Виджеты ещё не собирались')
  })
})

describe('общая плашка', () => {
  it('generatedAt старше 8 ч — «виджеты не обновлялись N ч» и кнопка', async () => {
    set(status({ generatedAt: iso(10 * H + 60_000) }))
    await show(<WidgetsNotice />)
    expect(text()).toContain('Виджеты не обновлялись 10 ч')
    expect(host.querySelector('button')?.textContent).toContain('Обновить сейчас')
  })

  it('свежие без ошибок — ничего; token_expired — плашка', async () => {
    set(status())
    await show(<WidgetsNotice />)
    expect(host.innerHTML).toBe('')
    set(status({ errors: [{ code: 'token_expired', message: 'x' }] }))
    await show(<WidgetsNotice />)
    expect(text()).toContain('Токен статуса истёк')
  })
})

describe('кнопка «Обновить сейчас»', () => {
  it('без сети недоступна; во время опроса заблокирована', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await show(<RefreshButton />)
    expect(host.querySelector('button')!.disabled).toBe(true)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(host.querySelector('button')!.disabled).toBe(false)
    await act(async () => useWidgets.setState({ polling: true }))
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(text()).toContain('Жду данные')
  })

  it('нажатие — POST /api/status/refresh', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Проверка виджетов не настроена' } }), { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await show(<RefreshButton />)
    await act(async () => host.querySelector('button')!.click())
    await vi.waitFor(() => expect(useWidgets.getState().refreshNote).toBe('Проверка виджетов не настроена'))
    expect(fetchMock).toHaveBeenCalledWith('/api/status/refresh', expect.objectContaining({ method: 'POST' }))
  })
})
