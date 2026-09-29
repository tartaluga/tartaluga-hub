// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ACCESS_HINT, useSession } from '../app/session'
import { MobileSyncBar } from './MobileSyncBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const syncNow = vi.fn(() => Promise.resolve())

function mockMedia(matches: boolean) {
  window.matchMedia = ((q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  mockMedia(true)
  syncNow.mockClear()
  useSession.setState({ phase: 'ready', sync: 'idle', syncError: null, lastSync: new Date(), queued: 0, conflicts: [], deviceError: null, accessProblem: false, syncNow })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const show = (path = '/') =>
  act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <MobileSyncBar />
      </MemoryRouter>,
    ),
  )

describe('MobileSyncBar', () => {
  it('в обычном состоянии скрыта', async () => {
    await show()
    expect(host.innerHTML).toBe('')
  })

  it('идущая сверка без очереди не показывается', async () => {
    useSession.setState({ sync: 'syncing' })
    await show()
    expect(host.innerHTML).toBe('')
  })

  it('очередь — текст про ожидание отправки', async () => {
    useSession.setState({ queued: 1 })
    await show()
    expect(host.textContent).toContain('1 правка ждёт отправки')
  })

  it('offline виден', async () => {
    useSession.setState({ sync: 'offline' })
    await show()
    expect(host.textContent).toContain('OFFLINE')
  })

  it('нет доступа к репо данных — подсказка один раз (не дублируется причиной ошибки)', async () => {
    useSession.setState({ sync: 'error', syncError: ACCESS_HINT, accessProblem: true })
    await show()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(ACCESS_HINT)
    expect(host.textContent!.split('tartaluga-hub-data')).toHaveLength(2)
  })

  it('подсказка держит полоску видимой и во время сверки', async () => {
    useSession.setState({ sync: 'syncing', accessProblem: true })
    await show()
    expect(host.textContent).toContain(ACCESS_HINT)
  })

  it('ошибка устройства — role=alert', async () => {
    useSession.setState({ deviceError: 'Память устройства недоступна' })
    await show()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Память устройства недоступна')
  })

  it('нажатие вызывает syncNow', async () => {
    useSession.setState({ queued: 2 })
    await show()
    await act(async () => host.querySelector('button')!.click())
    expect(syncNow).toHaveBeenCalledTimes(1)
  })

  it('error и sessionExpired видны', async () => {
    useSession.setState({ sync: 'error' })
    await show()
    expect(host.textContent).toContain('SYNC · ошибка')
    useSession.setState({ sync: 'sessionExpired' })
    await show()
    expect(host.textContent).toContain('НУЖЕН ВХОД')
  })

  it('offline без очереди — «OFFLINE · данные из кэша»', async () => {
    useSession.setState({ sync: 'offline' })
    await show()
    expect(host.textContent).toContain('OFFLINE · данные из кэша')
  })

  it('syncing с очередью виден', async () => {
    useSession.setState({ sync: 'syncing', queued: 1 })
    await show()
    expect(host.textContent).toContain('SYNC · обновляю…')
  })

  it('syncing после видимого состояния не прячет полоску, а после конца — прячет', async () => {
    useSession.setState({ queued: 1 })
    await show()
    await act(async () => useSession.setState({ queued: 0, sync: 'syncing' }))
    expect(host.textContent).toContain('SYNC · обновляю…')
    await act(async () => useSession.setState({ sync: 'idle' }))
    expect(host.innerHTML).toBe('')
  })

  it('на /settings скрыта', async () => {
    useSession.setState({ queued: 1, deviceError: 'сбой' })
    await show('/settings')
    expect(host.innerHTML).toBe('')
    await show('/settings/security')
    expect(host.innerHTML).toBe('')
  })

  it('на ширине ПК не монтируется', async () => {
    mockMedia(false)
    useSession.setState({ queued: 1, deviceError: 'сбой' })
    await show()
    expect(host.innerHTML).toBe('')
  })

  it('причина ошибки показана', async () => {
    useSession.setState({ sync: 'error', syncError: 'GitHub ответил 502' })
    await show()
    expect(host.textContent).toContain('GitHub ответил 502')
  })
})
