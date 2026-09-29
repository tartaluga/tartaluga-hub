// Очередь правок (ADR-004) и входящие конфликты (ADR-004 шаг 5, ADR-010): сессия с поддельным сервером.
import { earlierVersions } from '../screens/Conflicts'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_HINT, ACCESS_HINT_AFTER_MS, UPSTREAM_RETRY_TEXT, DB_BLOCKED, DEVICE_READ_FAILED, DEVICE_WRITE_FAILED, installSyncTriggers, PARTLY_WRITTEN, QueueConflict, READ_ONLY, resetQueueMemory, unsentSnapshot, useSession, type Remote } from './session'
import { resetWriter } from './writer'
import { fakeLockHub, setLocks } from '../test/fakeLocks'
import { ApiError, type Me } from '../lib/api'
import { getCachedFiles, getConflicts, getQueue, putQueued, wipeDevice, type QueuedEdit } from '../lib/localdb'
import { idbStateStore, installDraftPersistence, setDraft, wipeDrafts } from '../lib/drafts'

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
  const state = { down: false, auth: false, fail: null as ApiError | null, listFail: null as ApiError | null, branchesFail: null as ApiError | null, status: 0, writes: [] as string[] }
  const check = () => {
    if (state.down) throw new ApiError(0, 'network', 'нет сети')
    if (state.status) throw new ApiError(state.status, 'server', `Сервер ответил ${state.status}`)
    if (state.auth) throw new ApiError(401, 'unauthorized', 'Нужно войти')
  }
  const remote: Remote = {
    async listBranches() {
      check()
      if (state.branchesFail) throw state.branchesFail
      return Object.keys(heads)
    },
    async me() {
      check()
      return ME
    },
    async listFiles(branch) {
      check()
      if (state.listFail) throw state.listFail
      const files = heads[branch]
      if (!files) throw new ApiError(404, 'branch_not_found', 'Ветки нет в репо данных')
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
  /** Удалить ветку «на GitHub». */
  const drop = (branch: string) => void delete heads[branch]
  return { remote, state, edit, text, drop }
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

/** Подмена Date.now в тестах подсказки (ADR-014); снимается после каждого теста. */
let dateNow: { mockRestore(): void } | null = null

afterEach(() => {
  dateNow?.mockRestore()
  dateNow = null
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

  it('«Скачать неотправленное» видит правки всех веток и конфликты, а не только открытую ветку', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    await useSession.getState().switchBranch('main')
    srv.state.fail = new ApiError(422, 'validation', 'не проходит схему')
    await useSession.getState().saveProject('a', { nextStep: 'отказ' }).catch(() => {})
    srv.state.fail = null
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'main' })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().saveProject('a', { title: 'feat' })
    const snap = unsentSnapshot()
    expect(snap.edits.map((e) => `${e.branch} ${JSON.parse(e.text).title}`).sort()).toEqual(['feat feat', 'main main'])
    expect(snap.conflicts.map((c) => `${c.branch} ${c.path}`)).toEqual([`main ${PATH}`])
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

describe('«удалено» — только подтверждённое сервером (ADR-014)', () => {
  const upstream = () => new ApiError(503, 'upstream_unavailable', 'GitHub сейчас не подтверждает данные — повторю позже')

  it.each([
    ['404 not_found, хотя файл есть в списке', () => new ApiError(404, 'not_found', 'Файла нет в ветке')],
    ['503 upstream_unavailable', upstream],
    ['404 no_route', () => new ApiError(404, 'no_route', 'Нет такой команды')],
  ])('запись отвечает %s — не конфликт: правка ждёт и уходит повтором', async (_name, error) => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = error()
    await useSession.getState().saveProject('a', { title: 'Моё' })
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getConflicts()).toEqual([])
    expect(useSession.getState().queued).toBe(1)
    expect(await getQueue()).toHaveLength(1)
    expect(shown().title).toBe('Моё')
    srv.state.fail = null
    await useSession.getState().flush()
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Моё')
    expect(useSession.getState().queued).toBe(0)
  })

  it('подтверждённое «файла нет» на записи, и в списке его нет — выбор «вернуть или согласиться»', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, null)
    srv.state.down = false
    srv.state.fail = new ApiError(404, 'not_found', 'Файла нет в ветке')
    await useSession.getState().flush()
    expect(useSession.getState().queued).toBe(0)
    expect(await getConflicts()).toMatchObject([{ branch: 'main', path: PATH, deleted: { mine: expect.stringContaining('Моё') } }])
  })

  it('запись в ветку отвечает branch_not_found — правка ждёт, ветку стирает только сверка', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.fail = new ApiError(404, 'branch_not_found', 'Ветки нет в репо данных')
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getQueue()).toHaveLength(1)
    expect(useSession.getState().branch).toBe('feat')
  })

  it.each([
    ['503 upstream_unavailable', upstream],
    ['неоднозначный 404 not_found старого сервера', () => new ApiError(404, 'not_found', 'Не найдено в репо данных')],
    ['404 no_route', () => new ApiError(404, 'no_route', 'Нет такой команды')],
  ])('сверка ветки ≠ main отвечает %s — ветка, её очередь и кэш целы', async (_name, error) => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    srv.state.down = false
    srv.state.listFail = error()
    await useSession.getState().refresh()
    expect(useSession.getState()).toMatchObject({ branch: 'feat', sync: 'error', branchNotice: null })
    expect(await getQueue()).toHaveLength(1)
    expect(useSession.getState().queued).toBe(1)
    expect(await getCachedFiles('feat')).toHaveLength(1)
    srv.state.listFail = null
    await useSession.getState().syncNow()
    expect(JSON.parse(srv.text('feat', PATH)).title).toBe('С ветки')
  })

  /** Ветка feat с неотправленной правкой (отложена: нет сети). */
  async function branchWithEdit() {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    srv.state.down = false
    return srv
  }

  async function expectBranchKept() {
    expect(useSession.getState()).toMatchObject({ branch: 'feat', sync: 'error', branchNotice: null })
    expect(await getQueue()).toHaveLength(1)
    expect(useSession.getState().queued).toBe(1)
    expect(await getCachedFiles('feat')).toHaveLength(1)
  }

  it('branch_not_found, но ветка есть в списке веток — сбой, ветка и очередь целы', async () => {
    const srv = await branchWithEdit()
    srv.state.listFail = new ApiError(404, 'branch_not_found', 'Ветки нет в репо данных')
    await useSession.getState().refresh()
    await expectBranchKept()
    expect(useSession.getState().syncError).toBe(UPSTREAM_RETRY_TEXT)
  })

  it('branch_not_found, а список веток не получен — сбой, ветка и очередь целы', async () => {
    const srv = await branchWithEdit()
    srv.state.listFail = new ApiError(404, 'branch_not_found', 'Ветки нет в репо данных')
    srv.state.branchesFail = new ApiError(503, 'upstream_unavailable', 'GitHub сейчас не отвечает. Попробуй ещё раз чуть позже.')
    await useSession.getState().refresh()
    await expectBranchKept()
  })

  it('branch_not_found и ветки нет в списке — ветка стирается с очередью и кэшем, открыта main', async () => {
    const srv = await branchWithEdit()
    srv.drop('feat')
    await useSession.getState().refresh()
    await vi.waitFor(() => expect(useSession.getState().branch).toBe('main'))
    expect(useSession.getState().branchNotice).toContain('feat')
    expect(await getQueue()).toEqual([])
    expect(useSession.getState().queued).toBe(0)
    expect(await getCachedFiles('feat')).toEqual([])
  })

  const unavailable = () => new ApiError(503, 'upstream_unavailable', 'GitHub сейчас не отвечает. Попробуй ещё раз чуть позже.')

  /** Подменяемые часы: Date.now() отдаёт заданное время, реальных задержек нет. */
  function clock() {
    let now = 1_000_000
    dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    return { at: (ms: number) => void (now = 1_000_000 + ms) }
  }

  it('несколько 503 за 10 с, в том числе от отправки очереди, — подсказки нет', async () => {
    const t = clock()
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = unavailable()
    for (let i = 0; i < 5; i++) {
      t.at(i * 2_000)
      await useSession.getState().saveProject('a', { title: `Моё ${i}` }) // запись 503
      srv.state.listFail = unavailable()
      await useSession.getState().refresh() // сверка 503
      srv.state.listFail = null
    }
    expect(useSession.getState()).toMatchObject({ accessProblem: false, syncError: UPSTREAM_RETRY_TEXT })
  })

  it(`503 без успеха ${ACCESS_HINT_AFTER_MS / 1000} с от первого — подсказка; успех её убирает и начинает отсчёт заново`, async () => {
    const t = clock()
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.listFail = unavailable()
    t.at(0)
    await useSession.getState().refresh()
    // Сбой сети между попытками про доступ к GitHub ничего не говорит: полосу не рвёт.
    srv.state.down = true
    t.at(30_000)
    await useSession.getState().refresh()
    srv.state.down = false
    t.at(ACCESS_HINT_AFTER_MS - 1)
    await useSession.getState().refresh()
    expect(useSession.getState().accessProblem).toBe(false)
    t.at(ACCESS_HINT_AFTER_MS)
    await useSession.getState().refresh()
    expect(useSession.getState()).toMatchObject({ accessProblem: true, syncError: ACCESS_HINT, sync: 'error' })
    srv.state.listFail = null
    t.at(ACCESS_HINT_AFTER_MS + 1_000)
    await useSession.getState().refresh()
    expect(useSession.getState()).toMatchObject({ accessProblem: false, sync: 'idle', syncError: null })
    // После успеха отсчёт с нуля: 503 через минуту после прошлого — первый в новой полосе.
    srv.state.listFail = unavailable()
    t.at(3 * ACCESS_HINT_AFTER_MS)
    await useSession.getState().refresh()
    expect(useSession.getState()).toMatchObject({ accessProblem: false, syncError: UPSTREAM_RETRY_TEXT })
  })

  it('первый 503 — не подсказка, даже после долгого перерыва; второй через минуту без успеха — подсказка', async () => {
    const t = clock()
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.listFail = unavailable()
    t.at(0)
    await useSession.getState().refresh()
    expect(useSession.getState().accessProblem).toBe(false)
    t.at(10 * ACCESS_HINT_AFTER_MS)
    await useSession.getState().refresh()
    expect(useSession.getState().accessProblem).toBe(true)
  })

  it('записанная правка сбрасывает полосу 503', async () => {
    const t = clock()
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = unavailable()
    t.at(0)
    await useSession.getState().saveProject('a', { title: 'Моё' })
    t.at(ACCESS_HINT_AFTER_MS)
    await useSession.getState().flush()
    expect(useSession.getState()).toMatchObject({ accessProblem: true, syncError: ACCESS_HINT })
    srv.state.fail = null
    await useSession.getState().flush()
    expect(useSession.getState().queued).toBe(0)
    expect(useSession.getState().accessProblem).toBe(false)
  })

  it('список веток длиннее 1000 не получен — ветка с очередью цела', async () => {
    const srv = await branchWithEdit()
    srv.state.listFail = new ApiError(404, 'branch_not_found', 'Ветки нет в репо данных')
    srv.state.branchesFail = new ApiError(502, 'upstream', 'GitHub не ответил как надо')
    await useSession.getState().refresh()
    await expectBranchKept()
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

  it('два удаления подряд с разными моими версиями: обе видны, прежняя — в earlier', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Первая' })
    srv.edit('main', PATH, null)
    srv.state.down = false
    await useSession.getState().flush()
    srv.edit('main', PATH, project())
    await useSession.getState().refresh()
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Вторая' })
    srv.edit('main', PATH, null)
    srv.state.down = false
    await useSession.getState().flush()
    const [c] = useSession.getState().conflicts
    expect(JSON.parse(c!.deleted!.mine).title).toBe('Вторая')
    expect(earlierVersions(c!).map((t) => JSON.parse(t).title)).toEqual(['Первая'])
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

/** Вторая вкладка хаба: свой экземпляр модулей сессии и лока (своя память), та же IndexedDB. */
async function secondTab(srv: ReturnType<typeof server>, boot = true) {
  vi.resetModules()
  const tab = await import('./session')
  const guard = await import('./signOutGuard')
  const writer = await import('./writer')
  const ideas = await import('../data/ideas')
  const drafts = await import('../lib/drafts')
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
  if (boot) {
    await tab.useSession.getState().boot()
    await tab.useSession.getState().syncNow()
  }
  return { ...tab, guard, writer, ideas, drafts }
}

/**
 * Две вкладки на одном устройстве (ADR-013): у каждой свой Web Lock-менеджер на общей «машине». Вкладка A
 * (этот модуль) стартует первой и пишет; B — вторая. close() — закрыть вкладку, её лок отпускается.
 */
async function twoTabs(srv: ReturnType<typeof server>, bootB = true) {
  const hub = fakeLockHub()
  const a = hub.tab()
  const b = hub.tab()
  resetWriter() // прежние тесты держат настоящий лок Node: отпускаем, дальше — поддельный
  const restoreA = setLocks(a.locks)
  await start(srv)
  restoreA()
  const restoreB = setLocks(b.locks) // до конца теста: B может стартовать позже
  const tabB = await secondTab(srv, bootB)
  const t = () => Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  const stopA = installSyncTriggers(new EventTarget(), t())
  const stopB = tabB.installSyncTriggers(new EventTarget(), t())
  cleanup.push(() => {
    stopA()
    stopB()
    restoreB()
    a.close()
    b.close()
    resetWriter()
  })
  /** «Заморозить» A: она больше не слышит сообщений других вкладок. */
  return { b: tabB, closeA: a.close, muteA: stopA }
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

describe('пишет одна вкладка (ADR-013)', () => {
  it('вторая вкладка не получила лок — только просмотр: правка отклонена, в очередь, на сервер и в IndexedDB ничего не пишется', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    expect(useSession.getState().readOnly).toBe(false)
    expect(b.useSession.getState().readOnly).toBe(true)
    const s = b.useSession.getState()
    await expect(s.saveProject('a', { title: 'Из B' })).rejects.toMatchObject({ status: 423, message: READ_ONLY })
    await expect(s.addIdea('ideas/01J8Z6Y0000000000000000001.json', '{}')).rejects.toMatchObject({ status: 423 })
    await expect(s.createFile('projects/b.json', '{}')).rejects.toMatchObject({ status: 423 })
    await expect(s.saveSettings((x) => x)).rejects.toMatchObject({ status: 423 })
    await expect(s.deleteTag('t')).rejects.toMatchObject({ status: 423 })
    await expect(s.deleteFiles(() => [PATH], 'удалить')).rejects.toMatchObject({ status: 423 })
    await expect(s.resolveConflict('main', PATH, [])).rejects.toMatchObject({ status: 423 })
    await expect(s.settleBranch('main')).rejects.toMatchObject({ status: 423 })
    expect(b.useSession.getState().queued).toBe(0)
    expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).title).toBe('А')
    expect(await getQueue()).toEqual([])
    expect(srv.state.writes).toEqual([])
    // Сверка в просмотре показывает свежее на экране, но кэш устройства не трогает: его пишет A.
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    await b.useSession.getState().syncNow()
    expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).title).toBe('С телефона')
    expect(JSON.parse((await getCachedFiles('main')).find((f) => f.path === PATH)!.text).title).toBe('А')
  })

  it('пишущая закрылась — вторая становится пишущей, подхватывает очередь с устройства и отправляет её', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b, closeA } = await twoTabs(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    expect(await getQueue()).toHaveLength(1)
    srv.state.down = false
    closeA()
    await vi.waitFor(() => expect(b.useSession.getState().readOnly).toBe(false))
    await vi.waitFor(() => expect(JSON.parse(srv.text('main', PATH)).title).toBe('Из A'))
    await vi.waitFor(async () => expect(await getQueue()).toEqual([]))
    expect(b.useSession.getState().queued).toBe(0)
    await b.useSession.getState().saveProject('a', { nextStep: 'из B' })
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Из A', nextStep: 'из B' })
  })

  it('просмотр, открытый без сети при чужой правке в очереди, показывает её значение и считает её', async () => {
    const srv = server({ main: { [PATH]: project({ status: 'paused' }) } })
    const { b } = await twoTabs(srv, false)
    srv.state.down = true
    await useSession.getState().saveProject('a', { status: 'done' })
    expect(useSession.getState().queued).toBe(1)
    await b.useSession.getState().boot()
    await b.useSession.getState().syncNow()
    expect(b.useSession.getState().readOnly).toBe(true)
    expect(b.useSession.getState().sync).toBe('offline')
    expect(b.useSession.getState().queued).toBe(1)
    expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).status).toBe('done')
  })

  it.each([404, 500])('сервер отвечает %i на старте — просмотр всё равно показывает чужую правку из очереди и считает её', async (status) => {
    const srv = server({ main: { [PATH]: project({ status: 'paused' }) } })
    const { b } = await twoTabs(srv, false)
    srv.state.down = true
    await useSession.getState().saveProject('a', { status: 'done' })
    srv.state.down = false
    srv.state.status = status
    await b.useSession.getState().boot()
    await b.useSession.getState().syncNow()
    expect(b.useSession.getState().readOnly).toBe(true)
    expect(b.useSession.getState().phase).toBe('ready')
    expect(b.useSession.getState().queued).toBe(1)
    expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).status).toBe('done')
  })

  it.each([404, 500])('сервер отвечает %i на старте — пишущая поднимает свою очередь и показывает правку', async (status) => {
    const srv = server({ main: { [PATH]: project({ status: 'paused' }) } })
    await start(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { status: 'done' })
    resetQueueMemory() // перезапуск вкладки
    useSession.setState({ phase: 'booting', files: [] })
    srv.state.down = false
    srv.state.status = status
    await useSession.getState().boot()
    await useSession.getState().syncNow()
    expect(useSession.getState().phase).toBe('ready')
    expect(useSession.getState().queued).toBe(1)
    expect(JSON.parse(useSession.getState().files.find((f) => f.path === PATH)!.text).status).toBe('done')
    // 404 не от API хаба — не «файл удалён»: правка ждёт в очереди, а не уходит во «Входящие».
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getQueue()).toHaveLength(1)
    srv.state.status = 0
    await useSession.getState().syncNow()
    expect(JSON.parse(srv.text('main', PATH)).status).toBe('done')
  })

  it('404 не от API хаба на открытой ветке — ветка и её кэш с правкой остаются', async () => {
    const srv = server({ main: { [PATH]: project() }, feat: { [PATH]: project() } })
    await start(srv)
    await useSession.getState().switchBranch('feat')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'С ветки' })
    srv.state.down = false
    srv.state.status = 404
    await useSession.getState().refresh()
    expect(useSession.getState().branch).toBe('feat')
    expect(await getQueue()).toHaveLength(1)
    expect(await getCachedFiles('feat')).toHaveLength(1)
  })

  it('пишущая меняет данные — вкладка просмотра по сообщению перечитывает очередь и файлы', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    await vi.waitFor(() => expect(b.useSession.getState().queued).toBe(1))
    await vi.waitFor(() => expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).title).toBe('Из A'))
    srv.state.down = false
    await b.useSession.getState().syncNow() // просмотр видит чужую правку, но не отправляет её
    expect(srv.state.writes).toEqual([])
    await useSession.getState().flush()
    await vi.waitFor(() => expect(b.useSession.getState().queued).toBe(0))
    expect(JSON.parse(b.useSession.getState().files.find((f) => f.path === PATH)!.text).title).toBe('Из A')
  })

  it('выход из вкладки просмотра: страж видит неотправленное пишущей, устройство стёрто, пишущая тоже выходит', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    expect(await b.guard.unsentCounts()).toMatchObject({ edits: 1, conflicts: 0 })
    await b.useSession.getState().signOut()
    expect(b.useSession.getState().phase).toBe('signedOut')
    await vi.waitFor(() => expect(useSession.getState().phase).toBe('signedOut'))
    expect(useSession.getState().queued).toBe(0)
    expect(await getQueue()).toEqual([])
    expect(await getCachedFiles('main')).toEqual([])
  })

  it('просмотр: «Сделать проектом» и запись в обход сессии ничего не коммитят и не пишут', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const commit = vi.fn(srv.remote.commit)
    srv.remote.commit = commit
    const { b } = await twoTabs(srv)
    const idea = { schemaVersion: 1, id: '01J8Z6Y0000000000000000001', text: 'Идея', createdAt: '2026-09-23T14:32:00+03:00' }
    const draft = { slug: 'idea', path: 'projects/idea.json', text: project({ slug: 'idea' }) }
    await expect(b.ideas.makeProjectFromIdea(idea as never, draft)).rejects.toMatchObject({ status: 423 })
    // Защита в глубине: даже если вход пропустили, запись на сервер и на устройство отклоняется.
    await expect(b.writeRemote().putFile('main', PATH, '{}')).rejects.toMatchObject({ status: 423 })
    await expect(b.writeRemote().commit('main', [], 'h', 'm')).rejects.toMatchObject({ status: 423 })
    await b.applyWrite('main', [{ path: 'projects/x.json', sha: 's', text: '{}' }], [PATH])
    expect(commit).not.toHaveBeenCalled()
    expect(srv.state.writes).toEqual([])
    expect((await getCachedFiles('main')).map((f) => f.path)).toEqual([PATH])
    expect(b.useSession.getState().files.map((f) => f.path)).toEqual([PATH])
  })

  it('«Писать здесь»: пишущая сохраняет черновик в handoff и уступает; просящая пишет, забирает черновик и очередь', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    const store = idbStateStore()
    vi.stubGlobal('window', new EventTarget()) // тест в Node: подписки на уход со страницы — в пустоту
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    const stop = installDraftPersistence(store, () => ({ route: '#/', scrollY: 0, now: Date.now(), build: 't' }))
    // Закрыть базу черновиков обеих «вкладок»: открытое соединение закрытой вкладки держало бы её стирание.
    cleanup.push(stop, () => wipeDrafts(), () => b.drafts.wipeDrafts())
    setDraft('project:a:description', 'А · описание', 'недописанный текст')
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Из A' })
    // Как main.tsx: ставшая пишущей вкладка забирает черновики из handoff.
    const taken = new Promise<void>((resolve) => b.writer.onBecameWriter(() => void b.drafts.restoreHandoff(b.drafts.idbStateStore(), Date.now()).then(() => resolve())))
    srv.state.down = false
    b.useSession.getState().requestWrite()
    await vi.waitFor(() => expect(b.useSession.getState().readOnly).toBe(false))
    await taken
    expect(b.drafts.restoredDraft('project:a:description')).toBe('недописанный текст')
    expect(useSession.getState().readOnly).toBe(true)
    expect(b.useSession.getState().takeover).toBeNull()
    await vi.waitFor(() => expect(JSON.parse(srv.text('main', PATH)).title).toBe('Из A'))
    await expect(useSession.getState().saveProject('a', { title: 'Снова A' })).rejects.toMatchObject({ status: 423 })
    await b.useSession.getState().saveProject('a', { nextStep: 'из B' })
    expect(JSON.parse(srv.text('main', PATH))).toMatchObject({ title: 'Из A', nextStep: 'из B' })
  })

  it('разбор конфликта в полёте и «Писать здесь»: пишущая дожидается его — конфликт снят и на устройстве, новая его не видит', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Моё' })
    srv.edit('main', PATH, project({ title: 'С телефона' }))
    srv.state.down = false
    await useSession.getState().flush()
    expect(await getConflicts()).toHaveLength(1)
    const put = srv.remote.putFile.bind(srv.remote)
    let answer!: () => void
    let asked!: () => void
    const waiting = new Promise<void>((resolve) => (asked = resolve))
    const gate = new Promise<void>((resolve) => (answer = resolve))
    srv.remote.putFile = async (...args) => {
      asked()
      await gate
      return put(...args)
    }
    const resolving = useSession.getState().resolveConflict('main', PATH, [{ index: 0, pick: 'mine' }])
    await waiting
    b.useSession.getState().requestWrite()
    await new Promise((r) => setTimeout(r, 20))
    expect(useSession.getState().readOnly).toBe(false) // уступит только после разбора
    answer()
    await resolving
    await vi.waitFor(() => expect(b.useSession.getState().readOnly).toBe(false))
    expect(await getConflicts()).toEqual([])
    expect(b.useSession.getState().conflicts).toEqual([])
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Моё')
  })

  it('правка не легла на устройство — пишущая пробует ещё раз; не вышло — не уступает, у просящей «не может уступить»', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    srv.state.down = true
    vi.mocked(putQueued).mockRejectedValueOnce(new Error('QuotaExceededError')).mockRejectedValueOnce(new Error('QuotaExceededError'))
    await useSession.getState().saveProject('a', { title: 'Только в памяти' })
    expect(await getQueue()).toEqual([])
    b.useSession.getState().requestWrite()
    await vi.waitFor(() => expect(b.useSession.getState().takeover).toBe('refused'))
    expect(useSession.getState().readOnly).toBe(false)
    expect(b.useSession.getState().readOnly).toBe(true)
    // Вторая попытка: запись на устройство прошла — уступает, правка едет через IndexedDB.
    b.useSession.getState().requestWrite()
    await vi.waitFor(() => expect(b.useSession.getState().readOnly).toBe(false))
    expect(useSession.getState().readOnly).toBe(true)
    expect((await getQueue()).map((e) => JSON.parse(e.text).title)).toEqual(['Только в памяти'])
    expect(b.useSession.getState().queued).toBe(1)
  })

  it('пишущая без Web Locks не может отпустить запись — не уступает и остаётся пишущей', async () => {
    const srv = server({ main: { [PATH]: project() } })
    resetWriter()
    const restoreA = setLocks(undefined)
    await start(srv)
    restoreA()
    // B видит лок занятым (как если бы A его держала) и ждёт вечно.
    const busy = { request: ((_n: string, opts: LockOptions | ((l: Lock | null) => unknown), cb?: (l: Lock | null) => unknown) => (typeof opts === 'object' && opts.ifAvailable ? Promise.resolve(cb!(null)) : new Promise(() => undefined))) as LockManager['request'] }
    const restoreB = setLocks(busy)
    const b = await secondTab(srv)
    const t = () => Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    const stops = [installSyncTriggers(new EventTarget(), t()), b.installSyncTriggers(new EventTarget(), t())]
    cleanup.push(() => {
      for (const stop of stops) stop()
      restoreB()
      resetWriter()
    })
    expect(b.useSession.getState().readOnly).toBe(true)
    b.useSession.getState().requestWrite()
    await vi.waitFor(() => expect(b.useSession.getState().takeover).toBe('refused'))
    expect(useSession.getState().readOnly).toBe(false)
    await useSession.getState().saveProject('a', { title: 'Всё ещё пишу' })
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Всё ещё пишу')
  })

  it('«Писать здесь», а пишущая не отвечает (заморожена) — просмотр остаётся, на плашке «не отвечает»', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b, muteA } = await twoTabs(srv)
    muteA()
    b.useSession.getState().requestWrite(30)
    expect(b.useSession.getState().takeover).toBe('asking')
    await vi.waitFor(() => expect(b.useSession.getState().takeover).toBe('noAnswer'))
    expect(b.useSession.getState().readOnly).toBe(true)
    expect(useSession.getState().readOnly).toBe(false)
  })

  it('становясь пишущей, вкладка сначала поднимает очередь с устройства и только потом принимает правки', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b, closeA } = await twoTabs(srv)
    // Запись, которую сборка не понимает: разбирает только пишущая (во «Входящие»).
    await putQueued({ branch: 'main', path: 'projects/b.json', kind: 'unknown', baseSha: 'x', baseText: '{}', patch: {}, text: '{"моя":"версия"}', queuedAt: '2026-09-01T10:00:00+03:00' } as unknown as QueuedEdit)
    const seen: number[] = []
    b.useSession.subscribe((st, prev) => {
      if (prev.readOnly && !st.readOnly) seen.push(st.conflicts.length)
    })
    closeA()
    await vi.waitFor(() => expect(seen).toEqual([1]))
  })

  it('лок пришёл, пока вкладка ещё стартует, — становится пишущей только после старта', async () => {
    const srv = server({ main: { [PATH]: project() } })
    const { b, closeA } = await twoTabs(srv, false)
    let answer!: () => void
    const me = srv.remote.me.bind(srv.remote)
    const gate = new Promise<void>((resolve) => (answer = resolve))
    b.useSession.setState({ remote: { ...b.useSession.getState().remote, me: async () => (await gate, me()) } })
    const booting = b.useSession.getState().boot()
    await vi.waitFor(() => expect(b.useSession.getState().readOnly).toBe(true))
    closeA()
    await vi.waitFor(() => expect(b.writer.isWriter()).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(b.useSession.getState().readOnly).toBe(true) // старт не закончен — ещё просмотр
    answer()
    await booting
    await vi.waitFor(() => expect(b.useSession.getState().readOnly).toBe(false))
    expect(b.useSession.getState().phase).toBe('ready')
  })

  it.each([
    ['запись дошла', null],
    ['сервер отказал — конфликт', new ApiError(422, 'validation', 'отказ')],
  ])('выход из просмотра, пока пишущая ждёт ответа (%s), — на устройстве ничего не остаётся', async (_name, failure) => {
    const srv = server({ main: { [PATH]: project() } })
    const { b } = await twoTabs(srv)
    const put = srv.remote.putFile.bind(srv.remote)
    let answer!: () => void
    let asked!: () => void
    const waiting = new Promise<void>((resolve) => (asked = resolve))
    const gate = new Promise<void>((resolve) => (answer = resolve))
    srv.remote.putFile = async (...args) => {
      asked()
      await gate
      if (failure) throw failure
      return put(...args)
    }
    const saving = useSession.getState().saveProject('a', { title: 'Из A' }).catch(() => undefined)
    await waiting
    await b.useSession.getState().signOut()
    await vi.waitFor(() => expect(useSession.getState().phase).toBe('signedOut'))
    answer()
    await saving
    await new Promise((r) => setTimeout(r, 20))
    expect(await getQueue()).toEqual([])
    expect(await getConflicts()).toEqual([])
    expect(await getCachedFiles('main')).toEqual([])
    expect(useSession.getState().conflicts).toEqual([])
  })

  it('без Web Locks (старый браузер) вкладка пишет, как одна', async () => {
    resetWriter()
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

describe('очередь с устройства', () => {
  it('очередь не читается с устройства — своё сообщение, не «правка не сохранилась»', async () => {
    const srv = server({ main: { [PATH]: project() } })
    vi.mocked(getQueue).mockRejectedValueOnce(new Error('UnknownError'))
    await start(srv)
    expect(useSession.getState().deviceError).toBe(DEVICE_READ_FAILED)
    await useSession.getState().boot()
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

describe('идеи в очереди (ADR-004): создание повторяемо', () => {
  const IDEA = 'ideas/01J8Z6Y0000000000000000001.json'
  const ideaText = (text: string) => JSON.stringify({ schemaVersion: 1, id: '01J8Z6Y0000000000000000001', text, createdAt: '2026-09-23T14:32:00+03:00' })

  it('ответ на создание потерялся — повтор видит тот же файл в репо: успех, записан один раз', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    const put = srv.remote.putFile.bind(srv.remote)
    let lost = false
    srv.remote.putFile = async (...args) => {
      const res = await put(...args)
      if (!lost) {
        lost = true
        throw new ApiError(0, 'network', 'ответ потерялся')
      }
      return res
    }
    await useSession.getState().addIdea(IDEA, ideaText('Идея'))
    expect(useSession.getState().queued).toBe(1)
    await useSession.getState().flush() // сервер строгий: создание поверх готового файла — 409, дальше сверка
    expect(srv.state.writes).toEqual([`main ${IDEA}`])
    expect(srv.text('main', IDEA)).toBe(ideaText('Идея'))
    expect(useSession.getState().queued).toBe(0)
    expect(useSession.getState().conflicts).toEqual([])
    expect(await getQueue()).toEqual([])
  })

  it('два отказа подряд по одному файлу — обе мои версии во «Входящих», прежняя не затёрта', async () => {
    const srv = server({ main: { [PATH]: project() } })
    await start(srv)
    srv.state.fail = new ApiError(422, 'validation', 'первый отказ')
    await useSession.getState().saveProject('a', { title: 'Б' }).catch(() => undefined)
    srv.state.fail = new ApiError(422, 'validation', 'второй отказ')
    await useSession.getState().saveProject('a', { title: 'В' }).catch(() => undefined)
    for (const c of [useSession.getState().conflicts[0], (await getConflicts())[0]]) {
      expect(c!.refused!.reason).toBe('второй отказ')
      expect(JSON.parse(c!.refused!.mine).title).toBe('В')
      expect(c!.refused!.earlier!.map((t) => JSON.parse(t).title)).toEqual(['Б'])
    }
    // Та же версия ещё раз — без повторов в прежних.
    srv.state.fail = new ApiError(422, 'validation', 'третий отказ')
    await useSession.getState().saveProject('a', { title: 'Б' }).catch(() => undefined)
    const [c] = await getConflicts()
    expect(JSON.parse(c!.refused!.mine).title).toBe('Б')
    expect(c!.refused!.earlier!.map((t) => JSON.parse(t).title)).toEqual(['В'])
  })
})

describe('запись очереди, которую сборка не понимает (ADR-011 §6)', () => {
  it('не роняет чтение очереди: другая правка уходит, эта — во «Входящих» целиком и из очереди удалена', async () => {
    const srv = server({ main: { [PATH]: project(), 'projects/b.json': project({ slug: 'b' }) } })
    const base = project()
    await putQueued({ branch: 'main', path: 'projects/b.json', kind: 'unknown', baseSha: 'x', baseText: '{}', patch: {}, text: '{"моя":"версия"}', queuedAt: '2026-09-01T10:00:00+03:00' } as unknown as QueuedEdit)
    await start(srv)
    const sha = useSession.getState().files.find((f) => f.path === PATH)!.sha
    await putQueued({ kind: 'project', branch: 'main', path: PATH, baseSha: sha, baseText: base, patch: { title: 'Б' }, text: project({ title: 'Б' }), queuedAt: '2026-09-02T10:00:00+03:00', id: 'y' })
    resetQueueMemory()
    useSession.setState({ phase: 'booting' })
    await start(srv)
    expect(JSON.parse(srv.text('main', PATH)).title).toBe('Б')
    expect(srv.state.writes).toEqual([`main ${PATH}`])
    expect(await getQueue()).toEqual([])
    const [c] = await getConflicts()
    expect(c).toMatchObject({ branch: 'main', path: 'projects/b.json', refused: { mine: '{"моя":"версия"}' } })
    expect(c!.refused!.reason).toMatch(/unknown/)
    expect(useSession.getState().conflicts).toHaveLength(1)
    expect(useSession.getState().deviceError).toBeNull()
  })
})
