// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../app/session'
import { ApiError } from '../lib/api'
import { Branches } from './Branches'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BRANCHES = {
  branches: [
    { name: 'main', head: 'c'.repeat(40), main: true, service: false },
    { name: 'draft', head: 'b'.repeat(40), main: false, service: false },
  ],
}

let root: Root
let host: HTMLElement
let confirm: ReturnType<typeof vi.fn<(message?: string) => boolean>>

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Сервер: список веток и ответ на «Влить». Запоминает вызовы. */
function server(merge: unknown) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (url.endsWith('/api/branches') && (init.method ?? 'GET') === 'GET') return reply(BRANCHES)
    if (url.endsWith('/api/branches/draft/merge') && init.method === 'POST') return reply(merge)
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const mergeCalls = (fetch: ReturnType<typeof server>) => fetch.mock.calls.filter(([u]) => String(u).includes('/merge'))

beforeEach(() => {
  useSession.setState({
    phase: 'ready',
    branch: 'main',
    settleBranch: async () => {},
    refresh: async () => {},
  })
  confirm = vi.fn<(message?: string) => boolean>(() => true)
  window.confirm = confirm
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function show() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Branches />
      </MemoryRouter>,
    ),
  )
}

async function clickMerge() {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Влить в main'))
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

describe('экран «Ветки»: «Влить в main»', () => {
  it('влито без замечаний — «влита в main»', async () => {
    server({ merged: true, head: 'f'.repeat(40) })
    await show()
    await clickMerge()
    const note = host.querySelector('[role="status"]')
    expect(note?.textContent).toContain('«draft» влита в main.')
    expect(host.textContent).not.toContain('не проходят проверку')
  })

  it('влито, но итог не проходит проверку — предупреждение со списком файлов', async () => {
    server({
      merged: true,
      head: 'f'.repeat(40),
      warnings: [{ path: 'projects/bot.json', error: 'status: недопустимое значение' }],
    })
    await show()
    await clickMerge()
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('влита в main, но файлы не проходят проверку')
    expect(alert?.textContent).toContain('projects/bot.json')
    expect(alert?.textContent).toContain('status: недопустимое значение')
  })

  it('в ветке неотправленные правки (settleBranch — 423): текст отказа, на сервер «Влить» не уходит', async () => {
    const text = 'В ветке «draft» ещё 1 правка — разбери сначала: дождись сети.'
    const settle = vi.fn(async () => {
      throw new ApiError(423, 'queue_pending', text)
    })
    useSession.setState({ settleBranch: settle })
    const fetch = server({ merged: true, head: 'f'.repeat(40) })
    await show()
    await clickMerge()
    expect(settle).toHaveBeenCalledWith('draft')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(text)
    expect(mergeCalls(fetch)).toHaveLength(0)
    expect(host.textContent).not.toContain('влита в main')
  })

  it('отказ в диалоге подтверждения — ничего не происходит', async () => {
    confirm.mockReturnValue(false)
    const fetch = server({ merged: true, head: 'f'.repeat(40) })
    await show()
    await clickMerge()
    expect(mergeCalls(fetch)).toHaveLength(0)
  })
})
