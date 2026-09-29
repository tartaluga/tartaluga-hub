// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../app/session'
import { MobileSyncBar } from './MobileSyncBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const syncNow = vi.fn(() => Promise.resolve())

beforeEach(() => {
  syncNow.mockClear()
  useSession.setState({ phase: 'ready', sync: 'idle', syncError: null, lastSync: new Date(), queued: 0, conflicts: [], deviceError: null, syncNow })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const show = () => act(async () => root.render(<MobileSyncBar />))

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
})
