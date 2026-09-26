// Очередь правок (ADR-004) и входящие конфликты (ADR-004 шаг 5, ADR-010): сессия с поддельным сервером.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_BLOCKED, DEVICE_READ_FAILED, DEVICE_WRITE_FAILED, installSyncTriggers, PARTLY_WRITTEN, QueueConflict, resetQueueMemory, useSession, type Remote } from './session'
import { ApiError, type Me } from '../lib/api'
import { getCachedFiles, getConflicts, getQueue, putQueued, wipeDevice } from '../lib/localdb'

// Запись в очередь на устройстве настоящая, но её можно уронить в отдельном тесте.
vi.mock('../lib/localdb', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/localdb')>()
  return { ...real, putQueued: vi.fn(real.putQueued), getQueue: vi.fn(real.getQueue) }
})
import { STALE_BUILD } from '../lib/update'

const ME: Me = {
  unseenSecurityEvents: 0,
  session: { authMethod: 'passkey', authAt: 1, fresh: false, createdAt: 1, expiresAt: 2, device: 'Chrome, Windows' },
}

const PATH = 'projects/a.json'

const project = (over: object = {}) =>
  JSON.stringify({
    schemaVersion: 2,
    slug: 'a',
    title: 'А',
    status: 'active',
    nextStep: 'шаг',
    future: 1,
    createdAt: '2026-09-01T10:00:00+03:00',
    updatedAt: '2026-09-01T10:00:00+03:00',
    ...over,
  })

/**
 * Сервер как репо: деревья по веткам, запись с устаревшим sha — 409. down — нет сети, auth — сессия кончилась.
 */
function server(trees: Record<string, Record<string, string>>) {
  const blobs = new Map<string, string>()
  const heads: Record<string, Map<string, string>> = {}
  let n = 0
  const store = (text: string) => {
    const sha = `s${++n}`
    blobs.set(sha, text)
    return sha
  }
  for (const [branch, files] of Object.entries(trees)) {
    heads[branch] = new Map(Object.entries(files).map(([p, t]) => [p, store(t)]))
  }
  const state = { down: false, auth: false, fail: null as ApiError | null, writes: [] as string[] }
  const check = () => {
    if (state.down) throw new ApiError(0, 'network', 'нет сети')
    if (state.auth) throw new ApiError(401, 'unauthorized', 'Нужно войти')
  }
  const remote: Remote = {
    async me() {
      check()
      return ME
    },
    async listFiles(branch) {
      check()
      const files = heads[branch]
      if (!files) throw new ApiError(404, 'not_found', 'Нет ветки')
      return { head: `h${n}`, files: [...files].map(([path, sha]) => ({ path, sha })) }
    },
    async readBlobText(sha) {
      check()
      return blobs.get(sha)!
    },
    async putFile(branch, path, text, sha) {
      check()
      if (state.fail) throw state.fail
      const files = heads[branch]!
      if (sha === undefined ? files.has(path) : files.get(path) !== sha) throw new ApiError(409, 'conflict', 'Файл изменился')
      state.writes.push(`${branch} ${path}`)
      const next = store(text)
      files.set(path, next)
      return { sha: next }
    },
    async commit() {
      throw new Error('не нужен')
    },
  }
  /** Изменить файл «на другом устройстве». */
  const edit = (branch: string, path: string, text: string | null) => {
    if (text === null) heads[branch]!.delete(path)
    else heads[branch]!.set(path, store(text))
  }
  const text = (branch: string, path: string) => blobs.get(heads[branch]!.get(path)!)!
  return { remote, state, edit, text }
}

const shown = () => JSON.parse(useSession.getState().files.find((f) => f.path === PATH)!.text)

async function start(srv: ReturnType<typeof server>) {
  useSession.setState({ remote: srv.remote })
  await useSession.getState().boot()
  await useSession.getState().syncNow() // та же сверка, что запустил boot: refresh отдаёт её промис
}

beforeEach(async () => {
  resetQueueMemory()
  await wipeDevice()
  useSession.setState({ phase: 'booting', me: null, branch: 'main', branchNotice: null, files: [], tree: null, sync: 'idle', syncError: null, lastSync: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('очередь правок: без сети', () => {
  it('правка без сети не теряется: сразу на экране, в IndexedDB с базой, уходит после появления сети', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    const baseSha = useSession.getState().files[0]!.sha
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(shown().title).toBe('Б')
    expect(useSession.getState().queued).toBe(1)
    const [q] = await getQueue()
    expect(q).toMatchObject({ branch: 'main', path: PATH, baseSha, patch: { title: 'Б' } })
    expect(JSON.parse(q!.baseText).title).toBe('А')
    srv.state.down = false
    await useSession.getState().syncNow()
    expect(srv.state.writes).toEqual([`main ${PATH}`])
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Б')
    expect(await getQueue()).toEqual([])
    expect(useSession.getState().queued).toBe(0)
  })

  it('две правки одного файла без сети — одна ожидающая правка с прежней базой, один коммит', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    const baseSha = useSession.getState().files[0]!.sha
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    await useSession.getState().saveProject('a', { nextStep: 'новый' })
    const queue = await getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ baseSha, patch: { title: 'Б', nextStep: 'новый' } })
    expect(shown()).toMatchObject({ title: 'Б', nextStep: 'новый' })
    srv.state.down = false
    await useSession.getState().flush()
    expect(srv.state.writes).toHaveLength(1)
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Б', nextStep: 'новый', future: 1 })
  })

  it('очередь переживает перезапуск: после старта правка на экране и уходит на сервер', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    resetQueueMemory() // «закрыли вкладку»: в памяти ничего, в IndexedDB — очередь
    useSession.setState({ phase: 'booting', files: [], queued: 0 })
    await useSession.getState().boot() // без сети: данные и правка с устройства
    expect(useSession.getState().phase).toBe('ready')
    expect(useSession.getState().queued).toBe(1)
    expect(shown().title).toBe('Б')
    srv.state.down = false
    resetQueueMemory()
    await start(srv) // старт с сетью — отправка
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Б')
    expect(await getQueue()).toEqual([])
  })

  it('сверка с сервером не стирает с экрана ожидающую правку', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = new ApiError(503, 'server', 'Сервер недоступен')
    await useSession.getState().saveProject('a', { title: 'Б' })
    srv.edit('main', PATH, project({ nextStep: 'с телефона' }))
    await useSession.getState().refresh()
    expect(shown()).toMatchObject({ title: 'Б' })
    expect(useSession.getState().queued).toBe(1)
    srv.state.fail = null
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Б', nextStep: 'с телефона' })
  })

  it('navigator.storage.persist — один раз, при первой правке в очередь', async () => {
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } })
    const srv = server({ main: { [PATH]: project() } })
    useSession.setState({ remote: srv.remote, phase: 'ready', me: ME })
    await useSession.getState().refresh()
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    await useSession.getState().saveProject('a', { title: 'В' })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('устаревшая сборка (409 STALE_BUILD) — не конфликт: правка ждёт обновления', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = new ApiError(409, STALE_BUILD, 'устарела')
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(useSession.getState().queued).toBe(1)
    expect(useSession.getState().conflicts).toEqual([])
  })

  it('сервер отказал по существу (422) — правка не теряется: во «Входящих» целиком, на экране версия из репо', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = new ApiError(422, 'validation', 'не проходит схему')
    const err = await useSession.getState().saveProject('a', { title: 'Б' }).catch((e) => e)
    expect(err).toBeInstanceOf(QueueConflict)
    expect(useSession.getState().queued).toBe(0)
    expect(shown().title).toBe('А')
    const [c] = useSession.getState().conflicts
    expect(c!.refused!.reason).toBe('не проходит схему')
    expect(JSON.parse(c!.refused!.mine).title).toBe('Б')
    srv.state.fail = null
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'repo' }])
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getConflicts()).toEqual([])
  })
})

describe('очередь правок: сессия кончилась (401)', () => {
  it('отправка останавливается на первом 401, правки ждут; после входа уходят все', async () => {
    const B = 'projects/b.json'
    const srv = server({ main: { [PATH]: project(), [B]: project({ slug: 'b', title: 'Бэ' }) } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'А2' })
    await useSession.getState().saveProject('b', { title: 'Бэ2' })
    srv.state.down = false
    srv.state.auth = true
    const put = vi.spyOn(srv.remote, 'putFile')
    await useSession.getState().flush()
    expect(put).toHaveBeenCalledTimes(1) // второй файл не пробовали
    expect(useSession.getState().sync).toBe('sessionExpired')
    expect(useSession.getState().queued).toBe(2)
    await useSession.getState().flush() // пока нет входа — ничего не отправляется
    expect(put).toHaveBeenCalledTimes(1)
    srv.state.auth = false
    await useSession.getState().signedIn()
    await useSession.getState().flush()
    expect(useSession.getState().queued).toBe(0)
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('А2')
    expect(JSON.parse(srv.text('main', B)).title).toBe('Бэ2')
  })
})

describe('очередь правок: триггеры отправки', () => {
  const setup = async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    srv.state.down = false
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    const stop = installSyncTriggers(win, doc)
    return { srv, win, doc, stop }
  }
  const settle = async () => {
    for (let i = 0; i < 20 && useSession.getState().queued; i++) await new Promise((r) => setTimeout(r, 5))
  }

  it('событие online — отправка', async () => {
    const { win, stop } = await setup()
    win.dispatchEvent(new Event('online'))
    await settle()
    expect(useSession.getState().queued).toBe(0)
    stop()
  })

  it('возврат на вкладку — отправка; уход с вкладки — нет', async () => {
    const { doc, stop } = await setup()
    doc.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 20))
    expect(useSession.getState().queued).toBe(1)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(useSession.getState().queued).toBe(0)
    stop()
  })

  it('после отписки события ничего не запускают', async () => {
    const { win, stop } = await setup()
    stop()
    win.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 20))
    expect(useSession.getState().queued).toBe(1)
  })

  it('старт приложения — отправка', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    srv.state.down = false
    resetQueueMemory()
    useSession.setState({ phase: 'booting' })
    await useSession.getState().boot()
    await settle()
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Б')
  })

  it('после неудачи — повтор по таймеру с нарастающей паузой', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const srv = server({ main: { [PATH]: project() } })
    useSession.setState({ remote: srv.remote, phase: 'ready', me: ME })
    await useSession.getState().refresh()
    const stop = installSyncTriggers(new EventTarget(), Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    srv.state.fail = new ApiError(503, 'server', 'сбой')
    const put = vi.spyOn(srv.remote, 'putFile')
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(put).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(put).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000) // вторая пауза — 10 с
    expect(put).toHaveBeenCalledTimes(2)
    srv.state.fail = null
    await vi.advanceTimersByTimeAsync(5_000)
    expect(put).toHaveBeenCalledTimes(3)
    vi.useRealTimers() // дальше запись в IndexedDB и кэш — ждём настоящим временем
    await useSession.getState().flush()
    expect(useSession.getState().queued).toBe(0)
    stop()
  })
})

describe('очередь правок: ветки раздельны (ADR-007)', () => {
  it('правка с ветки уходит только в свою ветку, даже если открыли main; на main её не видно', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    await useSession.getState().switchBranch('main')
    expect(shown().title).toBe('А')
    srv.state.down = false
    await useSession.getState().syncNow()
    expect(srv.state.writes).toEqual([`feat ${PATH}`])
    expect(JSON.parse(srv.text('feat', PATH)).title).toBe('С ветки')
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('А')
    expect(shown().title).toBe('А')
    expect(JSON.parse((await getCachedFiles('feat')).find((f) => f.path === PATH)!.text).title).toBe('С ветки')
  })

  it('правки одного файла в разных ветках — две отдельные ожидающие правки', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat') // кэш ветки на устройстве, как после прошлого открытия
    await useSession.getState().switchBranch('main')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'main' })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().saveProject('a', { title: 'feat' })
    expect((await getQueue()).map((q) => q.branch).sort()).toEqual(['feat', 'main'])
    expect(shown().title).toBe('feat')
  })

  it('удаление ветки стирает её очередь и конфликты', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    srv.state.down = false
    await useSession.getState().branchDeleted('feat')
    expect(await getQueue()).toEqual([])
    expect(useSession.getState().queued).toBe(0)
  })
})

describe('конфликт при отправке (ADR-004 шаги 1–5)', () => {
  it('разные поля — чистое слияние, одна запись, конфликтов нет', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    srv.edit('main', PATH, project({ nextStep: 'с телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Б', nextStep: 'с телефона', future: 1 })
    expect(useSession.getState().conflicts).toEqual([])
    expect(shown()).toMatchObject({ title: 'Б', nextStep: 'с телефона' })
  })

  it('спорное поле — во «Входящие», слившееся записано; конфликт переживает перезапуск', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё', status: 'paused' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'С телефона', status: 'paused' })
    const conflicts = useSession.getState().conflicts
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ branch: 'main', path: PATH, title: 'С телефона', labels: ['название'] })
    expect(conflicts[0]!.items[0]).toMatchObject({ kind: 'field', path: ['title'], local: 'Моё', remote: 'С телефона', base: 'А' })
    expect(useSession.getState().queued).toBe(0)
    resetQueueMemory()
    useSession.setState({ phase: 'booting' })
    await useSession.getState().boot()
    expect(useSession.getState().conflicts).toHaveLength(1)
    expect(await getConflicts()).toHaveLength(1)
  })

  it('выбор «моя» записывает моё значение в свежую версию и убирает конфликт', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    srv.edit('main', PATH, project({ title: 'С телефона', nextStep: 'ещё позже' }))
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'mine' }])
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Моё', nextStep: 'ещё позже' })
    expect(shown().title).toBe('Моё')
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getConflicts()).toEqual([])
  })

  it('выбор «из репо» ничего не пишет и убирает конфликт', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    const writes = srv.state.writes.length
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'repo' }])
    expect(srv.state.writes).toHaveLength(writes)
    expect(useSession.getState().conflicts).toEqual([])
  })

  it('длинный текст: выбор по кускам записывает собранный текст', async () => {
    const base = 'один\nдва\nтри\n'
    const srv = server({ main: { [PATH]: project({ description: base }) } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { description: 'один (моё)\nдва\nтри\n' })
    srv.edit('main', PATH, project({ description: 'один (телефон)\nдва\nтри (телефон)\n' }))
    srv.state.down = false
    await useSession.getState().flush()
    const [c] = useSession.getState().conflicts
    expect(c!.items[0]!.path).toEqual(['description'])
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: { text: 'один (моё)\nдва\nтри (телефон)\n' } }])
    expect(JSON.parse(srv.text('main', PATH)).description).toBe('один (моё)\nдва\nтри (телефон)\n')
    expect(useSession.getState().conflicts).toEqual([])
  })

  it('задача удалена в репо, а у меня изменена — конфликт элемента; «из репо» удаляет её', async () => {
    const T = '01K5Y0000000000000000000AA'
    const task = { id: T, title: 'Сдать главу', done: false }
    const srv = server({ main: { [PATH]: project({ tasks: [task] }) } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { taskSet: [{ id: T, title: 'Сдать главу 2' }] })
    srv.edit('main', PATH, project())
    srv.state.down = false
    await useSession.getState().flush()
    const [c] = useSession.getState().conflicts
    expect(c!.items[0]).toMatchObject({ kind: 'element', deletedBy: 'remote' })
    expect(c!.labels[0]).toBe('задача «Сдать главу 2» · удалена в репо')
    expect(JSON.parse(srv.text('main', PATH)).tasks).toHaveLength(1) // по умолчанию оставлена
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'repo' }])
    expect(JSON.parse(srv.text('main', PATH))).not.toHaveProperty('tasks')
  })

  it('проект удалили в репо — конфликт; «моя» возвращает файл с моей правкой', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, null)
    srv.state.down = false
    await useSession.getState().flush()
    const [c] = useSession.getState().conflicts
    expect(c!.deleted).toBeDefined()
    expect(useSession.getState().files.find((f) => f.path === PATH)).toBeUndefined()
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'mine' }])
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Моё')
    expect(shown().title).toBe('Моё')
    expect(useSession.getState().conflicts).toEqual([])
  })

  it('файл в репо не читается — правка во «Входящих» целиком, на сервер ничего не пишется', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, '{ битый')
    srv.state.down = false
    await useSession.getState().flush()
    expect(srv.state.writes).toEqual([])
    expect(useSession.getState().conflicts[0]!.refused!.reason).toMatch(/JSON/)
    expect(useSession.getState().queued).toBe(0)
  })

  it('без сети выбор не записывается, конфликт остаётся', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    srv.state.down = true
    await expect(useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'mine' }])).rejects.toMatchObject({ status: 0 })
    expect(useSession.getState().conflicts).toHaveLength(1)
  })
})

/** Вторая вкладка хаба: свой экземпляр модуля сессии (своя память), та же IndexedDB. */
async function secondTab(srv: ReturnType<typeof server>) {
  vi.resetModules()
  const tab = await import('./session')
  // У вкладки свой экземпляр модулей: ошибки сервера — её ApiError, иначе instanceof в ней не сработает.
  const { ApiError: TabApiError } = await import('../lib/api')
  const remote = new Proxy(srv.remote, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      return async (...args: unknown[]) => {
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        } catch (e) {
          throw e instanceof ApiError ? new TabApiError(e.status, e.code, e.message) : e
        }
      }
    },
  })
  tab.useSession.setState({ remote })
  await tab.useSession.getState().boot()
  await tab.useSession.getState().syncNow()
  return tab
}

describe('две вкладки на одном устройстве', () => {
  it('правки одного файла из двух вкладок сливаются в одну запись: новая поверх, база — самая ранняя', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    const baseSha = useSession.getState().files[0]!.sha
    const b = await secondTab(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    await b.useSession.getState().saveProject('a', { nextStep: 'из B' })
    const queue = await getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ baseSha, patch: { title: 'Из A', nextStep: 'из B' } })
    srv.state.down = false
    await b.useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Из A', nextStep: 'из B' })
    expect(await getQueue()).toEqual([])
  })

  it('после отправки вкладка не стирает правку, которую другая вкладка дописала в запись', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    const b = await secondTab(srv) // вкладка B подняла правку A с устройства
    expect(b.useSession.getState().queued).toBe(1)
    await b.useSession.getState().saveProject('a', { nextStep: 'из B' })
    srv.state.down = false
    // A отправляет свою версию, о правке B не зная; запись B после этого не стирает, а подхватывает и отправляет.
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Из A', nextStep: 'из B' })
    expect(useSession.getState().queued).toBe(0)
    expect(await getQueue()).toEqual([])
  })

  it('две вкладки отправляют одновременно — правка уходит на сервер один раз', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    const b = await secondTab(srv) // обе вкладки держат одну правку в памяти
    expect(b.useSession.getState().queued).toBe(1)
    srv.state.down = false
    await Promise.all([useSession.getState().flush(), b.useSession.getState().flush()])
    expect(srv.state.writes).toEqual([`main ${PATH}`])
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Из A')
    expect(useSession.getState().queued).toBe(0)
    expect(b.useSession.getState().queued).toBe(0)
    expect(await getQueue()).toEqual([])
  })

  it('без Web Locks (старый браузер) очередь работает как в одной вкладке', async () => {
    vi.stubGlobal('navigator', {})
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(await getQueue()).toHaveLength(1)
    srv.state.down = false
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Б')
    expect(await getQueue()).toEqual([])
  })

  it('другая вкладка узнаёт о новой правке по BroadcastChannel и перечитывает очередь', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    const b = await secondTab(srv)
    const t = () => Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    const stopA = installSyncTriggers(new EventTarget(), t())
    const stopB = b.installSyncTriggers(new EventTarget(), t())
    try {
      srv.state.down = true
      await useSession.getState().saveProject('a', { title: 'Из A' })
      await vi.waitFor(() => expect(b.useSession.getState().queued).toBe(1))
      await vi.waitFor(() => expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).title).toBe('Из A'))
      srv.state.down = false
      await useSession.getState().flush()
      await vi.waitFor(() => expect(b.useSession.getState().queued).toBe(0))
    } finally {
      stopA()
      stopB()
    }
  })
})

describe('запись на устройство не удалась', () => {
  it('ошибка IndexedDB видна в индикаторе, правка остаётся в памяти и уходит на сервер', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    vi.mocked(putQueued).mockRejectedValueOnce(new Error('QuotaExceededError'))
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(useSession.getState().deviceError).toBe(DEVICE_WRITE_FAILED)
    expect(useSession.getState().queued).toBe(1)
    expect(shown().title).toBe('Б')
    expect(await getQueue()).toEqual([])
    srv.state.down = false
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Б')
    expect(useSession.getState().deviceError).toBeNull()
  })
})

describe('конфликты из двух вкладок', () => {
  it('вкладки записывают спорные места одного файла — оба места остаются', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    const b = await secondTab(srv) // B о будущем конфликте A не знает
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    expect(await getConflicts()).toHaveLength(1)
    srv.state.down = true
    await b.useSession.getState().saveProject('a', { nextStep: 'шаг из B' }).catch(() => undefined)
    srv.edit('main', PATH, project({ title: 'С телефона', nextStep: 'шаг с телефона' }))
    srv.state.down = false
    await b.useSession.getState().flush()
    const [c] = await getConflicts()
    expect(c!.items.map((it) => it.path.join('.')).sort()).toEqual(['nextStep', 'title'])
    expect(c!.items.find((it) => it.path[0] === 'title')).toMatchObject({ local: 'Моё' })
  })

  it('ветку удалили в одной вкладке — другая не возвращает её правки в базу', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    const b = await secondTab(srv) // B открыла ту же ветку и держит правку в памяти
    expect(b.useSession.getState().queued).toBe(1)
    const t = () => Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    const stopA = installSyncTriggers(new EventTarget(), t())
    const stopB = b.installSyncTriggers(new EventTarget(), t())
    try {
      await useSession.getState().branchDeleted('feat')
      await vi.waitFor(() => expect(b.useSession.getState().queued).toBe(0))
      await vi.waitFor(() => expect(b.useSession.getState().branch).toBe('main'))
      expect(await getQueue()).toEqual([])
    } finally {
      stopA()
      stopB()
    }
  })

  it('вкладка, не слышавшая об удалении ветки, дописала её правку — удалившая вкладка стирает её при перечитывании', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    const b = await secondTab(srv) // без BroadcastChannel: об удалении B не узнает
    await useSession.getState().branchDeleted('feat')
    await b.useSession.getState().saveProject('a', { nextStep: 'из B' })
    expect(await getQueue()).toHaveLength(1)
    await useSession.getState().settleBranch('main')
    expect(await getQueue()).toEqual([])
  })

  it('очередь не читается с устройства — своё сообщение, не «правка не сохранилась»', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    vi.mocked(getQueue).mockRejectedValueOnce(new Error('UnknownError'))
    await useSession.getState().settleBranch('main')
    expect(useSession.getState().deviceError).toBe(DEVICE_READ_FAILED)
    await useSession.getState().settleBranch('main')
    expect(useSession.getState().deviceError).toBeNull()
  })
})

describe('база на устройстве ждёт другие вкладки', () => {
  it('старая вкладка держит базу — индикатор просит её закрыть; закрыли — сообщение уходит, хаб стартует', async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('tartaluga-hub', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv')
        req.result.createObjectStore('files', { keyPath: 'path' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const srv = server({ main: { [PATH]: project() } })
    useSession.setState({ remote: srv.remote })
    const booting = useSession.getState().boot()
    try {
      await vi.waitFor(() => expect(useSession.getState().deviceError).toBe(DB_BLOCKED))
    } finally {
      old.close()
    }
    await booting
    expect(useSession.getState().deviceError).toBeNull()
    expect(useSession.getState().phase).toBe('ready')
  })
})

describe('ветка: «Влить» и удаление после отправки очереди', () => {
  it('сначала отправляет правки ветки; без сети — отказ с понятным текстом', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    await expect(useSession.getState().settleBranch('feat')).rejects.toThrow('В ветке «feat» ещё 1 неотправленная правка')
    await expect(useSession.getState().settleBranch('main')).resolves.toBeUndefined()
    srv.state.down = false
    await useSession.getState().settleBranch('feat')
    expect(JSON.parse(srv.text('feat', PATH)).title).toBe('С ветки')
  })

  it('правку ветки, сделанную в другой вкладке, тоже видно: без сети — отказ', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    const b = await secondTab(srv)
    await b.useSession.getState().switchBranch('feat')
    srv.state.down = true
    await b.useSession.getState().saveProject('a', { title: 'Из B' })
    expect(useSession.getState().queued).toBe(0) // вкладка A о правке ещё не знает
    await expect(useSession.getState().settleBranch('feat')).rejects.toThrow('В ветке «feat» ещё 1 неотправленная правка')
  })

  it('конфликт ветки не разобран — отказ', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('feat', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await expect(useSession.getState().settleBranch('feat')).rejects.toThrow(/1 конфликт — разбери сначала/)
  })
})

describe('разбор конфликтов: гонки', () => {
  const conflicted = async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    return srv
  }

  it('место изменили в репо ещё раз — «моя» не пишется вслепую: новое значение снова на выбор', async () => {
    const srv = await conflicted()
    srv.edit('main', PATH, project({ title: 'Ещё раз' }))
    const writes = srv.state.writes.length
    await expect(useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'mine' }])).rejects.toBeInstanceOf(QueueConflict)
    expect(srv.state.writes).toHaveLength(writes)
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Ещё раз')
    const [c] = useSession.getState().conflicts
    expect(c!.items[0]).toMatchObject({ path: ['title'], local: 'Моё', remote: 'Ещё раз' })
    expect((await getConflicts())[0]!.items[0]!.remote).toBe('Ещё раз')
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'mine' }])
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Моё')
    expect(useSession.getState().conflicts).toEqual([])
  })

  it('перечитывание с устройства посреди разбора не возвращает разобранное место', async () => {
    await conflicted()
    const reload = useSession.getState().settleBranch('main').catch(() => undefined) // встаёт в очередь раньше разбора
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'repo' }])
    await reload
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getConflicts()).toEqual([])
  })

  it('часть выбора записана, другое место изменили ещё раз — сообщение об этом, а не «ничего не записано»', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё', nextStep: 'мой шаг' })
    srv.edit('main', PATH, project({ title: 'С телефона', nextStep: 'шаг с телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    expect(useSession.getState().conflicts[0]!.items).toHaveLength(2)
    srv.edit('main', PATH, project({ title: 'С телефона', nextStep: 'ещё раз' }))
    const picks = useSession.getState().conflicts[0]!.items.map((_, index) => ({ index, pick: 'mine' as const }))
    await expect(useSession.getState().resolveConflict('main', PATH, picks)).rejects.toThrow(PARTLY_WRITTEN)
    const doc = JSON.parse(srv.text('main', PATH))
    expect(doc).toMatchObject({ title: 'Моё', nextStep: 'ещё раз' })
    expect(useSession.getState().conflicts[0]!.items).toMatchObject([{ path: ['nextStep'], remote: 'ещё раз' }])
  })

  it('отказ от правки, которую не удалось записать, не снимает спорные места файла', async () => {
    const srv = await conflicted()
    srv.state.fail = new ApiError(422, 'validation', 'не прошло схему')
    await useSession.getState().saveProject('a', { nextStep: 'плохое' }).catch(() => undefined)
    srv.state.fail = null
    const [c] = useSession.getState().conflicts
    expect(c!.refused).toBeDefined()
    expect(c!.items).toHaveLength(1)
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'repo' }])
    const [left] = useSession.getState().conflicts
    expect(left!.refused).toBeUndefined()
    expect(left!.items[0]).toMatchObject({ path: ['title'], local: 'Моё' })
    expect((await getConflicts())[0]!.refused).toBeUndefined()
  })

  it('новая правка во время слияния ждёт от сохранённой версии: разобранный конфликт не всплывает', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё', status: 'paused' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    const put = srv.remote.putFile.bind(srv.remote)
    let during: Promise<void> | null = null
    srv.remote.putFile = async (...args) => {
      const res = await put(...args)
      // Запись слияния прошла — в этот момент владелец правит проект ещё раз, и связь пропадает.
      if (!during) {
        during = useSession.getState().saveProject('a', { nextStep: 'новое' }).catch(() => undefined)
        srv.state.down = true
      }
      return res
    }
    await useSession.getState().flush()
    await during
    expect(useSession.getState().queued).toBe(1)
    expect(useSession.getState().conflicts).toHaveLength(1)
    await useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'repo' }])
    expect(useSession.getState().conflicts).toEqual([])
    srv.state.down = false
    await useSession.getState().flush()
    expect(useSession.getState().conflicts).toEqual([])
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'С телефона', status: 'paused', nextStep: 'новое' })
  })
})
