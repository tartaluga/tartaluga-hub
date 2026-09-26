// @vitest-environment happy-dom
// Черновики переживают не только обновление хаба: выгрузку PWA из фона, F5 (pagehide / visibilitychange→hidden)
// и конец сессии (вход заново поверх экрана или через GitHub). Та же запись handoff (ADR-011).
import 'fake-indexeddb/auto'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Shell } from '../app/Shell'
import { useSession } from '../app/session'
import { Project } from '../screens/Project'
import { ApiError, type Me } from './api'
import { HANDOFF_KEY, installDraftPersistence, resetDrafts, restoreHandoff, saveHandoff, type StateStore } from './drafts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_800_000_000_000
const project = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}
const files = [{ path: 'projects/bot.json', sha: 's1', text: JSON.stringify(project) }]

function memoryStore(): StateStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
  }
}

let root: Root
let host: HTMLElement
let store: ReturnType<typeof memoryStore>
let uninstall: () => void
let visibility: DocumentVisibilityState = 'visible'

const input = () => ({ route: '#/projects/bot', scrollY: 0, now: NOW, build: 'b1' })

beforeEach(() => {
  resetDrafts()
  store = memoryStore()
  uninstall = installDraftPersistence(store, input)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  uninstall()
  resetDrafts()
  vi.restoreAllMocks()
})

const render = (ui: ReactNode) => act(async () => root.render(ui))
const tick = () => new Promise((r) => setTimeout(r, 0))
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => host.querySelector(`[aria-label="${label}"]`) as T
const newTask = () => byLabel<HTMLInputElement>('Новая задача')

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const pagehide = () => act(async () => {
  window.dispatchEvent(new Event('pagehide'))
  await tick()
})

const hide = () => act(async () => {
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  await tick()
})

/** Страницу выгрузили (F5, Android убил PWA): всё из памяти пропало, новый запуск читает handoff. */
async function restart(ui: ReactNode, now = NOW + 60_000) {
  await act(async () => root.unmount())
  uninstall()
  resetDrafts()
  const res = await restoreHandoff(store, now)
  uninstall = installDraftPersistence(store, input)
  root = createRoot(host)
  await render(ui)
  return res
}

const projectScreen = () => (
  <MemoryRouter initialEntries={['/projects/bot']}>
    <Routes>
      <Route path="/projects/:slug" element={<Project />} />
    </Routes>
  </MemoryRouter>
)

describe('черновики при уходе со страницы', () => {
  beforeEach(() => useSession.setState({ files, saveProject: vi.fn(async () => {}) }))

  it('pagehide → перезапуск: текст новой задачи на месте, экран возвращается, запись удалена', async () => {
    await render(projectScreen())
    await type(newTask(), 'Купить домен')
    await pagehide()
    expect(store.data.has(HANDOFF_KEY)).toBe(true)

    const res = await restart(projectScreen())
    expect(res.route).toBe('/projects/bot')
    expect(newTask().value).toBe('Купить домен')
    expect(store.data.has(HANDOFF_KEY)).toBe(false)
  })

  it('visibilitychange→hidden тоже пишет (Android выгружает PWA из фона); visible — нет', async () => {
    await render(projectScreen())
    await type(byLabel<HTMLInputElement>('Срок новой задачи'), '2026-10-01')
    document.dispatchEvent(new Event('visibilitychange'))
    await act(tick)
    expect(store.data.has(HANDOFF_KEY)).toBe(false)
    await hide()
    await restart(projectScreen())
    expect(byLabel<HTMLInputElement>('Срок новой задачи').value).toBe('2026-10-01')
  })

  it('сохранённое поле не всплывает: запись при следующем уходе стирается', async () => {
    const saveProject = vi.fn(async () => {})
    useSession.setState({ saveProject })
    await render(projectScreen())
    await type(newTask(), 'Написать тесты')
    await hide()
    expect(store.data.has(HANDOFF_KEY)).toBe(true)

    await act(async () => newTask().form!.requestSubmit())
    expect(saveProject).toHaveBeenCalledOnce()
    expect(newTask().value).toBe('')
    await pagehide()
    expect(store.data.has(HANDOFF_KEY)).toBe(false)

    await restart(projectScreen())
    expect(newTask().value).toBe('')
  })

  it('запись обновления хаба уход без черновиков не стирает', async () => {
    await render(projectScreen())
    await type(newTask(), 'x')
    await hide()
    await type(newTask(), '')
    await saveHandoff(store, { ...input(), scrollY: 300 })
    await pagehide()
    expect(store.data.get(HANDOFF_KEY)).toMatchObject({ ui: { scrollY: 300 } })
  })
})

describe('сессия закончилась (401)', () => {
  const me: Me = { unseenSecurityEvents: 0, session: { authMethod: 'passkey', authAt: NOW, fresh: true, createdAt: NOW, expiresAt: NOW + 1e9, device: 'ПК' } }
  const expire = async () => {
    const remote = useSession.getState().remote
    useSession.setState({ remote: { ...remote, me: async () => Promise.reject(new ApiError(401, 'unauthorized', 'Нет сессии')) } })
    await act(async () => useSession.getState().refreshMe())
    useSession.setState({ remote })
  }
  const app = () => (
    <MemoryRouter initialEntries={['/projects/bot']}>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/projects/:slug" element={<Project />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )

  beforeEach(() => {
    useSession.setState({
      phase: 'ready',
      me,
      files,
      sync: 'idle',
      saveProject: vi.fn(async () => {}),
      // Экран уже загружен; «вход» возвращает сессию, не трогая данные на устройстве.
      boot: vi.fn(async () => useSession.setState({ phase: 'ready' })),
    })
  })

  it('401 → вход поверх экрана → вход по ключу: поле не размонтировано, текст на месте', async () => {
    await render(app())
    await type(newTask(), 'Важная мысль')
    const field = newTask()

    await expire()
    expect(useSession.getState().sync).toBe('sessionExpired')
    const dialog = host.querySelector('dialog')!
    expect(dialog.textContent).toContain('Сессия закончилась')
    expect(dialog.open).toBe(true)
    expect(newTask()).toBe(field)
    // Черновик уже на устройстве — на случай, если уйдём со страницы.
    await act(tick)
    expect(store.data.get(HANDOFF_KEY)).toMatchObject({ drafts: [{ key: 'project:bot:new-task:all:title', text: 'Важная мысль' }] })

    await act(async () => useSession.getState().signedIn())
    expect(host.querySelector('dialog')).toBeNull()
    expect(newTask()).toBe(field)
    expect(newTask().value).toBe('Важная мысль')
  })

  it('401 → вход через GitHub (уход со страницы) → возврат: текст на месте', async () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location)
    await render(app())
    await type(newTask(), 'Не потерять')
    await expire()

    const github = [...host.querySelectorAll('dialog button')].find((b) => b.textContent?.includes('GitHub')) as HTMLButtonElement
    await act(async () => {
      github.click()
      await tick()
    })
    expect(assign).toHaveBeenCalledWith('/api/auth/github/start')
    expect(store.data.has(HANDOFF_KEY)).toBe(true)

    useSession.setState({ sync: 'idle' })
    const res = await restart(app())
    expect(res.route).toBe('/projects/bot')
    expect(host.querySelector('dialog')).toBeNull()
    expect(newTask().value).toBe('Не потерять')
  })
})
