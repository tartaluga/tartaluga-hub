import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCachedStatus, putCachedStatus, wipeDevice } from '../lib/localdb'
import type { Status } from '../schema/types'
import { hydrateWidgets, installWidgets, loadWidgets, POLL_GAVE_UP, refreshWidgets, RELOAD_MIN_MS, resetWidgets, useWidgets } from './widgets'

function status(generatedAt: string, extra: Partial<Status> = {}): Status {
  return {
    schemaVersion: 1,
    generatedAt,
    lastSuccess: generatedAt,
    errors: [],
    projects: { a: { repo: { fullName: 'o/a', commits: [{ sha: 'abc1234', message: 'm', date: '2026-09-29T08:00:00Z' }] } } },
    ...extra,
  }
}

const T1 = '2026-09-29T10:00:00Z'
const T2 = '2026-09-29T12:00:00Z'

type Reply = { status: number; body: unknown } | 'network'
const ok = (s: Status | string) => ({ status: 200, body: { sha: 'x', text: typeof s === 'string' ? s : JSON.stringify(s) } })
const err = (status: number, code: string, message = 'm') => ({ status, body: { error: { code, message } } })

let replies: Record<string, Reply[]>
let calls: { method: string; path: string }[]
let now: number

function reply(method: string, path: string, ...r: Reply[]) {
  ;(replies[`${method} ${path}`] ??= []).push(...r)
}

const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  calls.push({ method, path })
  const queue = replies[`${method} ${path}`] ?? []
  const r = queue.length > 1 ? queue.shift()! : queue[0]
  if (!r || r === 'network') throw new TypeError('Failed to fetch')
  return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status })
})

// Только таймеры опроса: IndexedDB (fake-indexeddb) живёт на setImmediate и должна идти сама.
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

const gets = () => calls.filter((c) => c.method === 'GET').length

let stop: (() => void) | null = null
function install(canWrite = true) {
  stop = installWidgets({ canWrite: () => canWrite, now: () => now }, new EventTarget(), Object.assign(new EventTarget(), { visibilityState: 'visible' }))
}

beforeEach(async () => {
  replies = {}
  calls = []
  now = Date.parse('2026-09-29T12:30:00Z')
  vi.stubGlobal('fetch', fetchMock)
  resetWidgets()
  await wipeDevice()
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('загрузка status.json', () => {
  it('проверенный файл — в память и на устройство; commits для «заброшен»', async () => {
    reply('GET', '/api/status', ok(status(T1)))
    install()
    await vi.waitFor(async () => expect((await getCachedStatus())?.loadedAt).toBe(now))
    const s = useWidgets.getState()
    expect(s.status?.generatedAt).toBe(T1)
    expect(s.commits.get('a')).toBe(Date.parse('2026-09-29T08:00:00Z'))
  })

  it('404 not_found «ещё не собирались» — пустое состояние, не ошибка; кэш стирается', async () => {
    await putCachedStatus({ text: JSON.stringify(status(T1)), loadedAt: 1 })
    reply('GET', '/api/status', err(404, 'not_found', 'Виджеты ещё не собирались'))
    await loadWidgets(true)
    expect(useWidgets.getState()).toMatchObject({ status: null, empty: true, problem: null })
    expect(await getCachedStatus()).toBeNull()
  })

  it('не прошёл схему — прежние данные остаются, причина видна, кэш не перезаписан', async () => {
    reply('GET', '/api/status', ok(status(T1)), ok('{"schemaVersion":1}'))
    await loadWidgets(true)
    await loadWidgets(true)
    const s = useWidgets.getState()
    expect(s.status?.generatedAt).toBe(T1)
    expect(s.problem).toMatch(/не прошёл проверку/)
    expect(JSON.parse((await getCachedStatus())!.text).generatedAt).toBe(T1)
  })

  it('503 и 404 без not_found — временно: данные не трогаются', async () => {
    reply('GET', '/api/status', ok(status(T1)), err(503, 'upstream_unavailable'), err(404, 'no_route'))
    await loadWidgets(true)
    await loadWidgets(true)
    await loadWidgets(true)
    expect(useWidgets.getState()).toMatchObject({ empty: false, problem: null })
    expect(useWidgets.getState().status?.generatedAt).toBe(T1)
  })

  it('без сети — виджеты с устройства', async () => {
    await putCachedStatus({ text: JSON.stringify(status(T1)), loadedAt: 1 })
    install()
    await vi.waitFor(() => expect(useWidgets.getState().status?.generatedAt).toBe(T1))
  })

  it('ответ сервера свежее устройства: кэш его не затирает', async () => {
    await putCachedStatus({ text: JSON.stringify(status(T1)), loadedAt: 1 })
    reply('GET', '/api/status', ok(status(T2)))
    await loadWidgets(true)
    await hydrateWidgets()
    expect(useWidgets.getState().status?.generatedAt).toBe(T2)
  })

  it('вкладка просмотра на устройство не пишет (ADR-013)', async () => {
    reply('GET', '/api/status', ok(status(T1)))
    install(false)
    await vi.waitFor(() => expect(useWidgets.getState().status?.generatedAt).toBe(T1))
    expect(await getCachedStatus()).toBeNull()
  })

  it('возврат на вкладку и сеть — не чаще раза в 5 минут; старт — всегда', async () => {
    reply('GET', '/api/status', ok(status(T1)))
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    stop = installWidgets({ now: () => now }, win, doc)
    await vi.waitFor(() => expect(gets()).toBe(1))
    await loadWidgets() // дождаться первой загрузки (идущая загрузка переиспользуется)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(gets()).toBe(1)
    now += RELOAD_MIN_MS
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(gets()).toBe(2))
    doc.visibilityState = 'hidden'
    now += RELOAD_MIN_MS
    doc.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(gets()).toBe(2)
  })

  it('старт офлайн не удался — «сеть появилась» загружает сразу, без паузы 5 минут', async () => {
    reply('GET', '/api/status', 'network', ok(status(T1)))
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    stop = installWidgets({ now: () => now }, win, doc)
    await vi.waitFor(() => expect(gets()).toBe(1))
    await loadWidgets()
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(useWidgets.getState().status?.generatedAt).toBe(T1))
    expect(gets()).toBe(2)
  })

  it('выход сбрасывает память; запоздавший ответ ничего не пишет', async () => {
    let release!: () => void
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r))
      return new Response(JSON.stringify(ok(status(T1)).body), { status: 200 })
    })
    const loading = loadWidgets(true)
    resetWidgets()
    release()
    await loading
    expect(useWidgets.getState().status).toBeNull()
    expect(await getCachedStatus()).toBeNull()
  })
})

describe('«Обновить сейчас»', () => {
  async function loaded() {
    reply('GET', '/api/status', ok(status(T1)))
    await loadWidgets(true)
    replies['GET /api/status'] = []
    calls = []
  }

  it('POST refresh, опрос каждые 15 с, пока не сменится generatedAt; кнопка заблокирована на время опроса', async () => {
    await loaded()
    fakeTimers()
    reply('POST', '/api/status/refresh', { status: 202, body: { ok: true } })
    reply('GET', '/api/status', ok(status(T1)), ok(status(T1)), ok(status(T2)))
    const run = refreshWidgets()
    expect(useWidgets.getState().polling).toBe(true)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(gets()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(gets()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await run
    expect(gets()).toBe(3)
    expect(useWidgets.getState()).toMatchObject({ polling: false, refreshNote: null })
    expect(useWidgets.getState().status?.generatedAt).toBe(T2)
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/api/status/refresh' }])
  })

  it('3 минуты без новых данных — «не дождался»; сбой одного опроса не прерывает', async () => {
    await loaded()
    fakeTimers()
    reply('POST', '/api/status/refresh', { status: 202, body: { ok: true } })
    reply('GET', '/api/status', 'network', ok(status(T1)))
    const run = refreshWidgets()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    await run
    expect(gets()).toBe(12)
    expect(useWidgets.getState()).toMatchObject({ polling: false, refreshNote: POLL_GAVE_UP })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gets()).toBe(12)
  })

  it('повторное нажатие во время опроса ничего не делает', async () => {
    await loaded()
    fakeTimers()
    reply('POST', '/api/status/refresh', { status: 202, body: { ok: true } })
    reply('GET', '/api/status', ok(status(T2)))
    const run = refreshWidgets()
    await refreshWidgets()
    await vi.advanceTimersByTimeAsync(15_000)
    await run
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('виджетов ещё не было: первый появившийся status.json — успех', async () => {
    reply('GET', '/api/status', err(404, 'not_found'))
    await loadWidgets(true)
    replies['GET /api/status'] = []
    fakeTimers()
    reply('POST', '/api/status/refresh', { status: 202, body: { ok: true } })
    const after = '2100-01-01T00:00:00Z' // позже любого «сейчас» теста
    reply('GET', '/api/status', err(404, 'not_found'), ok(status(after)))
    const run = refreshWidgets()
    await vi.advanceTimersByTimeAsync(30_000)
    await run
    expect(useWidgets.getState()).toMatchObject({ polling: false, refreshNote: null, empty: false })
  })

  it('виджетов не было: status.json, собранный до нажатия, — ещё не успех (показан, опрос идёт дальше)', async () => {
    fakeTimers()
    reply('POST', '/api/status/refresh', { status: 202, body: { ok: true } })
    const after = '2100-01-01T00:00:00Z' // позже любого «сейчас» теста
    reply('GET', '/api/status', ok(status(T1)), ok(status(T1)), ok(status(after)))
    const run = refreshWidgets()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(useWidgets.getState()).toMatchObject({ polling: true })
    expect(useWidgets.getState().status?.generatedAt).toBe(T1)
    await vi.advanceTimersByTimeAsync(30_000)
    await run
    expect(gets()).toBe(3)
    expect(useWidgets.getState()).toMatchObject({ polling: false, refreshNote: null })
    expect(useWidgets.getState().status?.generatedAt).toBe(after)
  })

  it('ошибка запуска — её текст, без опроса', async () => {
    await loaded()
    reply('POST', '/api/status/refresh', err(404, 'not_found', 'Проверка виджетов не настроена'))
    await refreshWidgets()
    expect(useWidgets.getState()).toMatchObject({ polling: false, refreshNote: 'Проверка виджетов не настроена' })
    expect(gets()).toBe(0)
    reply('POST', '/api/status/refresh', 'network')
    replies['POST /api/status/refresh'] = ['network']
    await refreshWidgets()
    expect(useWidgets.getState().refreshNote).toMatch(/Нет связи/)
  })
})
