// Сессия и загрузка файлов данных через сервер хаба (ADR-007). Токена в браузере нет:
// вход — HttpOnly cookie, которую ставит сервер. Старт работает офлайн: сначала кэш из IndexedDB, потом сверка.
// Хаб всегда смотрит на одну ветку репо данных; у каждой ветки свой кэш на устройстве.
import { create } from 'zustand'
import { ApiError, commitChanges, getMe, isNetworkError, listFiles, logout, putFile, readBlobText, type CommitChange, type Me } from '../lib/api'
import {
  dropBranchCache,
  getCachedFiles,
  getCurrentBranch,
  putCachedFiles,
  requestPersistence,
  setCurrentBranch,
  wipeDevice,
  type CachedFile,
} from '../lib/localdb'
import { parseFile, serialize } from '../data/model'
import { applyEdit, EditConflict, rebaseEdit, type ProjectPatch } from '../data/editProject'

type Phase = 'booting' | 'signedOut' | 'ready'
/** sessionExpired: сессия кончилась, пока данные на экране — нужен вход, кэш и (позже) очередь правок ждут. */
type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'sessionExpired'

/** Откуда берём данные. В тестах подменяется. */
export interface Remote {
  me(): Promise<Me>
  listFiles(branch: string): Promise<{ head: string; files: { path: string; sha: string }[] }>
  readBlobText(sha: string): Promise<string>
  putFile(branch: string, path: string, text: string, sha?: string): Promise<{ sha: string }>
  commit(branch: string, changes: CommitChange[], expectedHead: string, message: string): Promise<{ head: string; shas: Record<string, string> }>
}

const serverRemote: Remote = { me: getMe, listFiles, readBlobText, putFile, commit: commitChanges }

/** Дерево открытой ветки на момент последней сверки: коммит и все пути данных (включая обложки). */
export interface Tree {
  head: string
  paths: string[]
}

export const MAIN = 'main'

interface Session {
  phase: Phase
  me: Me | null
  /** Открытая ветка репо данных. Всё, что на экране, и все правки — из неё. */
  branch: string
  /** Сообщение о ветке, которое нужно показать один раз (например, её удалили на другом устройстве). */
  branchNotice: string | null
  files: CachedFile[]
  /** null — ветку ещё не сверяли с сервером (старт без сети). Записи, которым нужен head, без него не идут. */
  tree: Tree | null
  sync: SyncState
  syncError: string | null
  lastSync: Date | null
  remote: Remote
  boot(): Promise<void>
  /** После входа (ключом) — перечитать сессию и данные. */
  signedIn(): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<void>
  refreshMe(): Promise<void>
  /** Открыть другую ветку: сразу её кэш с устройства, потом сверка с сервером. */
  switchBranch(name: string, notice?: string): Promise<void>
  /** Ветку удалили: стереть её кэш; если она была открыта — вернуться на main. */
  branchDeleted(name: string): Promise<void>
  dismissBranchNotice(): void
  /** Записать новый JSON-файл в открытую ветку. Повторяемо: тот же путь с тем же текстом — успех. */
  createFile(path: string, text: string): Promise<void>
  /** Удалить файлы одним коммитом. Если ветку успели сдвинуть — сверка и одна повторная попытка. */
  deleteFiles(paths: (tree: Tree) => string[], message: string): Promise<void>
  /**
   * Правка полей проекта. Правки одного файла идут по очереди, а все, что накопились, пока шла запись,
   * уходят следующим одним коммитом. Если файл успели изменить — слияние по полям и одна повторная попытка.
   */
  saveProject(slug: string, patch: ProjectPatch): Promise<void>
}

// Идущие сверки по веткам: повторный refresh той же ветки ждёт текущий, другой ветки — идёт параллельно.
const inFlight = new Map<string, Promise<void>>()

// Очередь правок по файлам: запись, которая идёт, и следующая, в которую склеиваются новые правки.
const saving = new Map<string, Promise<void>>()
const waiting = new Map<string, { patch: ProjectPatch; done: Promise<void> }>()

// Какие файлы держим в кэше как текст. Обложки грузятся отдельно (этап 8).
const isDataFile = (path: string) => /^(projects|ideas)\/[^/]+\.json$|^settings\.json$/.test(path)

export function errorText(e: unknown): string {
  if (isNetworkError(e)) return 'Нет связи с сервером хаба. Показываю данные с устройства.'
  if (e instanceof ApiError) return e.message
  return 'Что-то пошло не так. Попробуй ещё раз.'
}

export const useSession = create<Session>((set, get) => ({
  phase: 'booting',
  me: null,
  branch: MAIN,
  branchNotice: null,
  files: [],
  tree: null,
  sync: 'idle',
  syncError: null,
  lastSync: null,
  remote: serverRemote,

  async boot() {
    const branch = await getCurrentBranch().catch(() => MAIN)
    const files = await getCachedFiles(branch).catch(() => [])
    set({ branch })
    try {
      const me = await get().remote.me()
      set({ phase: 'ready', me, files })
      void requestPersistence()
      void get().refresh()
    } catch (e) {
      // Без сети, но данные на устройстве есть — работаем с ними; вход проверим, когда появится связь.
      if (isNetworkError(e) && files.length) set({ phase: 'ready', files, sync: 'offline', syncError: errorText(e) })
      else set({ phase: 'signedOut', files })
    }
  },

  async signedIn() {
    set({ sync: 'idle', syncError: null })
    await get().boot()
  },

  async signOut() {
    try {
      await logout() // сервер удаляет сессию и шлёт Clear-Site-Data
    } catch {
      /* без сети — всё равно стираем устройство; сессия истечёт сама */
    }
    await wipeDevice().catch(() => undefined)
    set({ phase: 'signedOut', me: null, branch: MAIN, branchNotice: null, files: [], tree: null, sync: 'idle', syncError: null, lastSync: null })
  },

  async refreshMe() {
    try {
      set({ me: await get().remote.me() })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ sync: 'sessionExpired', syncError: 'Сессия закончилась, войди снова.' })
    }
  },

  refresh() {
    const { branch, phase } = get()
    if (phase !== 'ready') return Promise.resolve()
    const running = inFlight.get(branch)
    if (running) return running
    const run = syncBranch(branch).finally(() => inFlight.delete(branch))
    inFlight.set(branch, run)
    return run
  },

  async switchBranch(name, notice) {
    if (name === get().branch) return
    await setCurrentBranch(name).catch(() => undefined)
    const files = await getCachedFiles(name).catch(() => [])
    set({ branch: name, files, tree: null, branchNotice: notice ?? null, sync: 'idle', syncError: null, lastSync: null })
    await get().refresh()
  },

  async branchDeleted(name) {
    await dropBranchCache(name).catch(() => undefined)
    if (get().branch === name) await get().switchBranch(MAIN)
  },

  dismissBranchNotice() {
    set({ branchNotice: null })
  },

  async createFile(path, text) {
    const { branch, remote } = get()
    const { sha } = await remote.putFile(branch, path, text)
    await applyWrite(branch, [{ path, sha, text }], [])
    void get().refresh()
  },

  async deleteFiles(pathsOf, message) {
    const { branch, remote } = get()
    for (let attempt = 0; ; attempt++) {
      if (!get().tree) await get().refresh()
      const tree = get().tree
      if (!tree || get().branch !== branch) throw new ApiError(0, 'network', 'Нет связи с сервером хаба — удаление не отправлено')
      const paths = pathsOf(tree).filter((p) => tree.paths.includes(p))
      if (!paths.length) return // уже удалено (например, на другом устройстве)
      try {
        const res = await remote.commit(branch, paths.map((path) => ({ path, text: null })), tree.head, message)
        await applyWrite(branch, [], paths, res.head)
        void get().refresh()
        return
      } catch (e) {
        // Ветку сдвинули после нашей сверки: перечитываем дерево и пробуем ещё раз, но только один.
        if (!(e instanceof ApiError && e.status === 409) || attempt > 0) throw e
        set({ tree: null })
      }
    }
  },

  saveProject(slug, patch) {
    const branch = get().branch
    const path = `projects/${slug}.json`
    const key = `${branch}
${path}`
    const next = waiting.get(key)
    if (next) {
      Object.assign(next.patch, patch)
      return next.done
    }
    const batch = { patch: { ...patch }, done: Promise.resolve() }
    const before = saving.get(key) ?? Promise.resolve()
    batch.done = before
      .catch(() => undefined)
      .then(() => {
        waiting.delete(key)
        return writeProject(branch, path, batch.patch)
      })
    waiting.set(key, batch)
    saving.set(key, batch.done)
    const cleanup = () => {
      if (saving.get(key) === batch.done) saving.delete(key)
    }
    batch.done.then(cleanup, cleanup)
    return batch.done
  },
}))

/** Текущая версия файла проекта на экране: разобранные данные и sha, от которого считается правка. */
function currentProject(branch: string, path: string) {
  const state = useSession.getState()
  if (state.branch !== branch) throw new ApiError(0, 'network', 'Открыта другая ветка — правка не отправлена')
  const file = state.files.find((f) => f.path === path)
  if (!file) throw new ApiError(404, 'not_found', 'Проекта больше нет в этой ветке')
  const parsed = parseFile(path, file.sha, file.text)
  if (!parsed.ok) throw new ApiError(422, 'validation', `Файл не читается: ${parsed.error}`)
  if (parsed.readOnly) throw new ApiError(422, 'validation', parsed.reason)
  return { sha: file.sha, data: parsed.data as Record<string, unknown> }
}

async function writeProject(branch: string, path: string, patch: ProjectPatch): Promise<void> {
  const { remote } = useSession.getState()
  const base = currentProject(branch, path)
  const put = async (from: { sha: string; data: Record<string, unknown> }) => {
    const text = serialize(applyEdit(from.data, patch))
    const { sha } = await remote.putFile(branch, path, text, from.sha)
    await applyWrite(branch, [{ path, sha, text }], [])
  }
  try {
    await put(base)
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e
    // Файл изменили в другом месте: берём свежую версию и накладываем правку, если её поля там не трогали.
    await useSession.getState().refresh()
    let fresh = currentProject(branch, path)
    // refresh мог вернуть сверку, начатую до конфликта, — тогда дочитываем ещё раз.
    if (fresh.sha === base.sha) {
      await useSession.getState().refresh()
      fresh = currentProject(branch, path)
    }
    if (fresh.sha === base.sha) throw e
    const r = rebaseEdit(base.data, fresh.data, patch)
    if (r.kind === 'already') return
    if (r.kind === 'conflict') throw new EditConflict(r.fields)
    await put(fresh)
  }
}

/** Сразу показать результат записи: кэш на устройстве, файлы на экране и дерево ветки. */
async function applyWrite(branch: string, changed: CachedFile[], removed: string[], head?: string): Promise<void> {
  await putCachedFiles(branch, changed, removed).catch(() => undefined)
  const state = useSession.getState()
  if (state.branch !== branch) return
  const files = new Map(state.files.map((f) => [f.path, f]))
  for (const p of removed) files.delete(p)
  for (const f of changed) files.set(f.path, f)
  const tree = state.tree && {
    head: head ?? state.tree.head,
    paths: [...state.tree.paths.filter((p) => !removed.includes(p)), ...changed.map((f) => f.path).filter((p) => !state.tree!.paths.includes(p))],
  }
  useSession.setState({ files: [...files.values()], tree })
}

/** Сверить кэш ветки с сервером. Если за это время открыли другую ветку, кэш обновляем, а экран не трогаем. */
async function syncBranch(branch: string): Promise<void> {
  const { remote } = useSession.getState()
  const current = () => useSession.getState().branch === branch
  useSession.setState({ sync: 'syncing', syncError: null })
  try {
    const { head, files: remoteFiles } = await remote.listFiles(branch)
    // На экране — кэш открытой ветки; если за время запроса ветку сменили, берём её кэш с устройства.
    const base = current() ? useSession.getState().files : await getCachedFiles(branch).catch(() => [] as CachedFile[])
    const cached = new Map(base.map((f) => [f.path, f]))
    const wanted = remoteFiles.filter((f) => isDataFile(f.path))

    // Качаем только то, чей sha поменялся: обычно это 0–2 файла.
    const changed: CachedFile[] = []
    for (const f of wanted) {
      if (cached.get(f.path)?.sha === f.sha) continue
      changed.push({ path: f.path, sha: f.sha, text: await remote.readBlobText(f.sha) })
    }
    const wantedPaths = new Set(wanted.map((f) => f.path))
    const removed = [...cached.keys()].filter((p) => !wantedPaths.has(p))

    if (changed.length || removed.length) await putCachedFiles(branch, changed, removed)
    if (!current()) return
    const next = new Map(cached)
    for (const p of removed) next.delete(p)
    for (const f of changed) next.set(f.path, f)
    useSession.setState({ files: [...next.values()], tree: { head, paths: remoteFiles.map((f) => f.path) }, sync: 'idle', lastSync: new Date() })
    if (!useSession.getState().me) void useSession.getState().refreshMe() // запускались без сети — теперь узнаём сессию
  } catch (e) {
    if (!current()) return
    const status = e instanceof ApiError ? e.status : -1
    // Ветку удалили на другом устройстве или на GitHub — возвращаемся на main, кэш ветки больше не нужен.
    if (status === 404 && branch !== MAIN) {
      await dropBranchCache(branch).catch(() => undefined)
      await useSession.getState().switchBranch(MAIN, `Ветки «${branch}» больше нет в репо данных — открыта main.`)
      return
    }
    useSession.setState({
      sync: status === 401 ? 'sessionExpired' : status === 0 ? 'offline' : 'error',
      syncError: status === 401 ? 'Сессия закончилась, войди снова.' : errorText(e),
    })
  }
}
