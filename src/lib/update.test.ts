import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, putFile } from './api'
import {
  BUILD_HEADER,
  BUILD_ID,
  createUpdater,
  localStorageAttempts,
  LOOP_WINDOW_MS,
  onStaleBuild,
  reportStaleBuild,
  STALE_BUILD,
  type AttemptLog,
  type UpdatePlatform,
} from './update'

const T0 = 1_800_000_000_000

function harness(opts: { waiting?: boolean; checkFinds?: boolean; saveFails?: boolean; attempts?: number[] } = {}) {
  let waiting = opts.waiting ?? false
  let now = T0
  let list = [...(opts.attempts ?? [])]
  const log: string[] = []
  const timers: { fn: () => void; at: number }[] = []
  const platform: UpdatePlatform = {
    hasWaiting: () => waiting,
    check: vi.fn(async () => {
      log.push('check')
      if (opts.checkFinds) waiting = true
      return waiting
    }),
    activate: () => void log.push('activate'),
    reload: () => void log.push('reload'),
  }
  const attempts: AttemptLog = { read: () => list, write: (l) => void (list = l) }
  const updater = createUpdater({
    platform,
    saveHandoff: async () => {
      log.push('handoff')
      if (opts.saveFails) throw new Error('quota')
    },
    attempts,
    now: () => now,
    schedule: (fn, ms) => void timers.push({ fn, at: now + ms }),
  })
  return {
    updater,
    log,
    timers,
    attempts: () => list,
    advance(ms: number) {
      now += ms
    },
    /** Запустить созревшие таймеры. */
    async tick() {
      for (const t of timers.splice(0).filter((t) => t.at <= now)) t.fn()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

describe('createUpdater: обновление без плашки', () => {
  it('новая версия ждёт: сначала handoff, потом включение', async () => {
    const h = harness({ waiting: true })
    expect(await h.updater.run('new_version')).toBe(true)
    expect(h.log).toEqual(['handoff', 'activate'])
    expect(h.updater.status()).toBe('updating')
    expect(h.attempts()).toEqual([T0])
  })

  it('при запуске handoff не пишется: прежний должна прочитать новая версия', async () => {
    const h = harness({ waiting: true })
    await h.updater.run('startup')
    expect(h.log).toEqual(['activate'])
  })

  it('stale_build без ждущей версии: спросить SW и включить найденную', async () => {
    const h = harness({ checkFinds: true })
    expect(await h.updater.run('stale_build')).toBe(true)
    expect(h.log).toEqual(['check', 'handoff', 'activate'])
  })

  it('stale_build, а SW новой версии не видит — перезагрузка (с handoff)', async () => {
    const h = harness()
    await h.updater.run('stale_build')
    expect(h.log).toEqual(['check', 'handoff', 'reload'])
  })

  it('второй запуск во время обновления ничего не делает', async () => {
    const h = harness({ waiting: true })
    const [a, b] = await Promise.all([h.updater.run('new_version'), h.updater.run('stale_build')])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(h.log.filter((x) => x === 'activate')).toHaveLength(1)
  })

  it('handoff не записался — не перезагружаемся (черновики не теряем) и повторяем позже', async () => {
    const h = harness({ waiting: true, saveFails: true })
    expect(await h.updater.run('new_version')).toBe(false)
    expect(h.log).toEqual(['handoff'])
    expect(h.updater.status()).toBe('deferred')
    expect(h.timers).toHaveLength(1)
  })
})

describe('защита от петли перезагрузок (не больше 2 попыток за 5 минут)', () => {
  it('третья попытка в окне откладывается, статус deferred, подписчики знают', async () => {
    const h = harness({ attempts: [T0 - 60_000, T0 - 30_000] })
    const seen: string[] = []
    h.updater.subscribe(() => seen.push(h.updater.status()))
    expect(await h.updater.run('stale_build')).toBe(false)
    expect(h.log).toEqual(['check'])
    expect(h.updater.status()).toBe('deferred')
    expect(seen).toEqual(['deferred'])
    // Повтор — когда из окна выйдет самая старая попытка.
    expect(h.timers.map((t) => t.at)).toEqual([T0 - 60_000 + LOOP_WINDOW_MS])
  })

  it('повторные сигналы в окне не плодят таймеры; после окна обновление проходит', async () => {
    const h = harness({ attempts: [T0 - 60_000, T0 - 30_000] })
    await h.updater.run('stale_build')
    await h.updater.run('new_version')
    expect(h.timers).toHaveLength(1)
    h.advance(LOOP_WINDOW_MS)
    await h.tick()
    await h.tick()
    expect(h.log.slice(-2)).toEqual(['handoff', 'reload'])
    expect(h.updater.status()).toBe('updating')
  })

  it('старые попытки и попытки «из будущего» не считаются', async () => {
    const h = harness({ waiting: true, attempts: [T0 - LOOP_WINDOW_MS - 1, T0 + 60_000] })
    expect(await h.updater.run('new_version')).toBe(true)
    expect(h.attempts()).toEqual([T0])
  })

  it('две попытки проходят, третья — нет', async () => {
    const h = harness({ attempts: [T0 - 1000] })
    expect(await h.updater.run('stale_build')).toBe(true)
    const h2 = harness({ attempts: h.attempts() })
    expect(await h2.updater.run('stale_build')).toBe(false)
  })
})

describe('localStorageAttempts', () => {
  function storage(init?: string) {
    const m = new Map<string, string>(init === undefined ? [] : [['tartaluga.update.attempts', init]])
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }

  it('пишет и читает', () => {
    const s = localStorageAttempts(storage())
    s.write([1, 2])
    expect(s.read()).toEqual([1, 2])
  })

  it.each(['не json', '{"a":1}', '[1,"x",null,2]'])('мусор (%s) не ломает защиту', (raw) => {
    expect(localStorageAttempts(storage(raw)).read()).toEqual(raw.startsWith('[') ? [1, 2] : [])
  })

  it('недоступное хранилище не бросает', () => {
    const s = localStorageAttempts({
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(s.read()).toEqual([])
    expect(() => s.write([1])).not.toThrow()
  })
})

describe('api.ts и номер сборки', () => {
  afterEach(() => {
    onStaleBuild(null)
    vi.unstubAllGlobals()
  })

  it('каждый запрос несёт X-Hub-Build', async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await api('/api/me')
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>)[BUILD_HEADER]).toBe(BUILD_ID)
    expect(BUILD_ID).toMatch(/^[0-9a-f]{7,64}$|^dev$/)
  })

  it('409 stale_build запускает обновление; ошибка доходит до вызвавшего (правка не считается сохранённой)', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: STALE_BUILD, message: 'устарела' } }), { status: 409 }))
    const handler = vi.fn()
    onStaleBuild(handler)
    const err = await putFile('main', 'projects/x.json', '{}').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(STALE_BUILD)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('другие ошибки обновление не запускают', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'conflict' } }), { status: 409 }))
    const handler = vi.fn()
    onStaleBuild(handler)
    await api('/api/file', { method: 'PUT', body: {} }).catch(() => undefined)
    expect(handler).not.toHaveBeenCalled()
    reportStaleBuild()
    expect(handler).toHaveBeenCalledOnce()
  })
})
