// Сессия и загрузка файлов данных через сервер хаба (ADR-007). Токена в браузере нет:
// вход — HttpOnly cookie, которую ставит сервер. Старт работает офлайн: сначала кэш из IndexedDB, потом сверка.
// Хаб всегда смотрит на одну ветку репо данных; у каждой ветки свой кэш на устройстве.
import { create } from 'zustand'
import { ApiError, getMe, isNetworkError, listFiles, logout, readBlobText, type Me } from '../lib/api'
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

type Phase = 'booting' | 'signedOut' | 'ready'
/** sessionExpired: сессия кончилась, пока данные на экране — нужен вход, кэш и (позже) очередь правок ждут. */
type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'sessionExpired'

/** Откуда берём данные. В тестах подменяется. */
export interface Remote {
  me(): Promise<Me>
  listFiles(branch: string): Promise<{ files: { path: string; sha: string }[] }>
  readBlobText(sha: string): Promise<string>
}

const serverRemote: Remote = { me: getMe, listFiles, readBlobText }

export const MAIN = 'main'

interface Session {
  phase: Phase
  me: Me | null
  /** Открытая ветка репо данных. Всё, что на экране, и все правки — из неё. */
  branch: string
  /** Сообщение о ветке, которое нужно показать один раз (например, её удалили на другом устройстве). */
  branchNotice: string | null
  files: CachedFile[]
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
}

// Идущие сверки по веткам: повторный refresh той же ветки ждёт текущий, другой ветки — идёт параллельно.
const inFlight = new Map<string, Promise<void>>()

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
    set({ phase: 'signedOut', me: null, branch: MAIN, branchNotice: null, files: [], sync: 'idle', syncError: null, lastSync: null })
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
    set({ branch: name, files, branchNotice: notice ?? null, sync: 'idle', syncError: null, lastSync: null })
    await get().refresh()
  },

  async branchDeleted(name) {
    await dropBranchCache(name).catch(() => undefined)
    if (get().branch === name) await get().switchBranch(MAIN)
  },

  dismissBranchNotice() {
    set({ branchNotice: null })
  },
}))

/** Сверить кэш ветки с сервером. Если за это время открыли другую ветку, кэш обновляем, а экран не трогаем. */
async function syncBranch(branch: string): Promise<void> {
  const { remote } = useSession.getState()
  const current = () => useSession.getState().branch === branch
  useSession.setState({ sync: 'syncing', syncError: null })
  try {
    const { files: remoteFiles } = await remote.listFiles(branch)
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
    useSession.setState({ files: [...next.values()], sync: 'idle', lastSync: new Date() })
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
