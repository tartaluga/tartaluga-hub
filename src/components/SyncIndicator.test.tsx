// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../app/session'
import type { StoredConflict } from '../lib/localdb'
import { downloadJson } from '../data/unsentExport'
import { SyncIndicator } from './SyncIndicator'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LABEL = 'Скачать неотправленное'
let root: Root
let host: HTMLElement

beforeEach(() => {
  useSession.setState({ phase: 'ready', branch: 'main', sync: 'idle', syncError: null, lastSync: null, queued: 0, conflicts: [], deviceError: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const show = () =>
  act(async () =>
    root.render(
      <MemoryRouter>
        <SyncIndicator />
      </MemoryRouter>,
    ),
  )
const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(LABEL))

describe('«Скачать неотправленное»', () => {
  it('нет очереди и конфликтов — кнопки нет', async () => {
    await show()
    expect(button()).toBeUndefined()
  })

  it('есть очередь — кнопка есть', async () => {
    useSession.setState({ queued: 2 })
    await show()
    expect(button()).toBeDefined()
  })

  it('по состоянию кнопка есть, а в памяти очереди пусто — ничего не скачивается', async () => {
    const c: StoredConflict = { branch: 'work', path: 'projects/bot.json', title: 'Бот', at: '2026-09-26T11:00:00.000Z', items: [], labels: [] }
    useSession.setState({ conflicts: [c] })
    const create = vi.spyOn(URL, 'createObjectURL')
    await show()
    await act(async () => button()!.click())
    expect(create).not.toHaveBeenCalled()
  })
})

describe('downloadJson', () => {
  it('Blob JSON, временная ссылка с download, после — ссылки в документе нет', async () => {
    vi.useFakeTimers()
    let blob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob
      return 'blob:test'
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: { href: string; download: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download })
    })
    downloadJson('hub-unsent.json', { a: 'б' })
    expect(clicked).toEqual([{ href: 'blob:test', download: 'hub-unsent.json' }])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(blob!.type).toBe('application/json')
    expect(JSON.parse(await blob!.text())).toEqual({ a: 'б' })
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(revoke).toHaveBeenCalledWith('blob:test')
    vi.useRealTimers()
  })
})
