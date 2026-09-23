// Сессия и загрузка файлов данных через сервер хаба (ADR-007). Токена в браузере нет:
// вход — HttpOnly cookie, которую ставит сервер. Старт работает офлайн: сначала кэш из IndexedDB, потом сверка.
import { create } from 'zustand'
import { ApiError, getMe, isNetworkError, listFiles, logout, readBlobText, type Me } from '../lib/api'
import { getCachedFiles, putCachedFiles, requestPersistence, wipeDevice, type CachedFile } from '../lib/localdb'

type Phase = 'booting' | 'signedOut' | 'ready'
/** sessionExpired: сессия кончилась, пока данные на экране — нужен вход, кэш и (позже) очередь правок ждут. */
type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'sessionExpired'

/** Откуда берём данные. В тестах подменяется. */
export interface Remote {
  me(): Promise<Me>
  listFiles(): Promise<{ files: { path: string; sha: string }[] }>
  readBlobText(sha: string): Promise<string>
}

const serverRemote: Remote = { me: getMe, listFiles: () => listFiles('main'), readBlobText }

interface Session {
  phase: Phase
  me: Me | null
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
}

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
  files: [],
  sync: 'idle',
  syncError: null,
  lastSync: null,
  remote: serverRemote,

  async boot() {
    const files = await getCachedFiles().catch(() => [])
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
    set({ phase: 'signedOut', me: null, files: [], sync: 'idle', syncError: null, lastSync: null })
  },

  async refreshMe() {
    try {
      set({ me: await get().remote.me() })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ sync: 'sessionExpired', syncError: 'Сессия закончилась, войди снова.' })
    }
  },

  async refresh() {
    const { remote, sync, phase } = get()
    if (phase !== 'ready' || sync === 'syncing') return
    set({ sync: 'syncing', syncError: null })
    try {
      const { files: remoteFiles } = await remote.listFiles()
      const cached = new Map(get().files.map((f) => [f.path, f]))
      const wanted = remoteFiles.filter((f) => isDataFile(f.path))

      // Качаем только то, чей sha поменялся: обычно это 0–2 файла.
      const changed: CachedFile[] = []
      for (const f of wanted) {
        if (cached.get(f.path)?.sha === f.sha) continue
        changed.push({ path: f.path, sha: f.sha, text: await remote.readBlobText(f.sha) })
      }
      const wantedPaths = new Set(wanted.map((f) => f.path))
      const removed = [...cached.keys()].filter((p) => !wantedPaths.has(p))

      if (changed.length || removed.length) await putCachedFiles(changed, removed)
      const next = new Map(cached)
      for (const p of removed) next.delete(p)
      for (const f of changed) next.set(f.path, f)
      set({ files: [...next.values()], sync: 'idle', lastSync: new Date() })
      if (!get().me) void get().refreshMe() // запускались без сети — теперь узнаём сессию
    } catch (e) {
      const status = e instanceof ApiError ? e.status : -1
      set({
        sync: status === 401 ? 'sessionExpired' : status === 0 ? 'offline' : 'error',
        syncError: status === 401 ? 'Сессия закончилась, войди снова.' : errorText(e),
      })
    }
  },
}))
