// Сессия: токен, клиент GitHub и загрузка файлов данных.
// Старт работает офлайн: сначала показываем кэш из IndexedDB, потом тихо сверяемся с GitHub.
import { create } from 'zustand'
import { DATA_REPO } from '../config'
import { GitHubClient, GitHubError } from '../lib/github'
import { getCachedFiles, getToken, putCachedFiles, requestPersistence, setToken, wipeDevice, type CachedFile } from '../lib/localdb'

type Phase = 'booting' | 'signedOut' | 'ready'
type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'tokenInvalid'

interface Session {
  phase: Phase
  client: GitHubClient | null
  files: CachedFile[]
  sync: SyncState
  syncError: string | null
  lastSync: Date | null
  boot(): Promise<void>
  signIn(token: string): Promise<string | null>
  signOut(): Promise<void>
  refresh(): Promise<void>
}

const makeClient = (token: string) => new GitHubClient({ token, ...DATA_REPO })

// Какие файлы держим в кэше как текст. Обложки грузятся отдельно (этап 8).
const isDataFile = (path: string) => /^(projects|ideas)\/[^/]+\.json$|^settings\.json$/.test(path)

export function errorText(e: unknown): string {
  if (!(e instanceof GitHubError)) return 'Что-то пошло не так. Попробуй ещё раз.'
  switch (e.kind) {
    case 'unauthorized':
      return 'GitHub не принял токен: он введён с ошибкой, истёк или отозван.'
    case 'not_found':
      return 'Токен не видит репозиторий tartaluga-hub-data. Проверь в настройках токена: Resource owner — tartaluga, Repository access — tartaluga-hub-data.'
    case 'forbidden':
      return 'Доступ запрещён. Возможно, токен ждёт одобрения в организации tartaluga или у него нет права Contents.'
    case 'rate_limited':
      return 'GitHub временно ограничил запросы. Подожди несколько минут.'
    case 'network':
      return 'Нет связи с GitHub. Проверь интернет.'
    case 'server':
      return 'GitHub сейчас отвечает ошибкой. Попробуй чуть позже.'
    default:
      return e.message
  }
}

export const useSession = create<Session>((set, get) => ({
  phase: 'booting',
  client: null,
  files: [],
  sync: 'idle',
  syncError: null,
  lastSync: null,

  async boot() {
    const token = await getToken().catch(() => null)
    if (!token) {
      set({ phase: 'signedOut' })
      return
    }
    const files = await getCachedFiles().catch(() => [])
    set({ phase: 'ready', client: makeClient(token), files })
    void get().refresh()
  },

  async signIn(raw) {
    const token = raw.trim()
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) {
      return 'Это не похоже на токен GitHub. Он начинается с github_pat_.'
    }
    const client = makeClient(token)
    try {
      await client.checkAccess()
    } catch (e) {
      return errorText(e)
    }
    await setToken(token)
    void requestPersistence()
    set({ phase: 'ready', client, files: await getCachedFiles().catch(() => []), sync: 'idle', syncError: null })
    void get().refresh()
    return null
  },

  async signOut() {
    await wipeDevice()
    set({ phase: 'signedOut', client: null, files: [], sync: 'idle', syncError: null, lastSync: null })
  },

  async refresh() {
    const { client, sync } = get()
    if (!client || sync === 'syncing') return
    set({ sync: 'syncing', syncError: null })
    try {
      const { files: remote } = await client.listFiles()
      const cached = new Map(get().files.map((f) => [f.path, f]))
      const wanted = remote.filter((f) => isDataFile(f.path))

      // Качаем только то, чей sha поменялся: обычно это 0–2 файла.
      const changed: CachedFile[] = []
      for (const f of wanted) {
        if (cached.get(f.path)?.sha === f.sha) continue
        changed.push({ path: f.path, sha: f.sha, text: await client.readBlobText(f.sha) })
      }
      const wantedPaths = new Set(wanted.map((f) => f.path))
      const removed = [...cached.keys()].filter((p) => !wantedPaths.has(p))

      if (changed.length || removed.length) await putCachedFiles(changed, removed)
      const next = new Map(cached)
      for (const p of removed) next.delete(p)
      for (const f of changed) next.set(f.path, f)
      set({ files: [...next.values()], sync: 'idle', lastSync: new Date() })
    } catch (e) {
      const kind = e instanceof GitHubError ? e.kind : null
      set({
        sync: kind === 'unauthorized' ? 'tokenInvalid' : kind === 'network' ? 'offline' : 'error',
        syncError: errorText(e),
      })
    }
  },
}))
