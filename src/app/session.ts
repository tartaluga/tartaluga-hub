// Сессия и загрузка файлов данных через сервер хаба (ADR-007). Токена в браузере нет:
// вход — HttpOnly cookie, которую ставит сервер. Старт работает офлайн: сначала кэш из IndexedDB, потом сверка.
// Хаб всегда смотрит на одну ветку репо данных; у каждой ветки свой кэш на устройстве.
import { create } from 'zustand'
import { wipeDrafts } from '../lib/drafts'
import { ApiError, commitChanges, getMe, isNetworkError, listFiles, logout, putFile, readBlobText, type CommitChange, type Me } from '../lib/api'
import {
  deleteConflict,
  deleteQueued,
  dropBranchCache,
  getCachedFiles,
  getConflicts,
  getCurrentBranch,
  getQueue,
  putCachedFiles,
  putConflict,
  putQueued,
  requestPersistence,
  setCurrentBranch,
  wipeDevice,
  type CachedFile,
  type QueuedEdit,
  type StoredConflict,
} from '../lib/localdb'
import { STALE_BUILD } from '../lib/update'
import { nowIso, parseFile, SCHEMA_VERSIONS, serialize, type WithUnknown } from '../data/model'
import { merge, MergeRefused, type JsonObject, type MergeConflict } from '../data/merge'
import { applyOps, conflictLabel, opsFor, sameContent, type ConflictPick } from '../data/conflicts'
import type { Project } from '../schema/types'
import { normalizeProject } from '../data/normalize'
import { validateSettings } from '../schema/validators.js'
import { removeTag, type SettingsChange, type SettingsData } from '../components/TagEditor.model'
import { untagProjects } from '../data/projects'
import { applyEdit, mergePatch, type ProjectPatch } from '../data/editProject'

type Phase = 'booting' | 'signedOut' | 'ready'
/** sessionExpired: сессия кончилась, пока данные на экране — нужен вход, кэш и очередь правок ждут (ADR-010 §4). */
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
  /** Сколько правок ждут отправки — по всем веткам (ADR-004). */
  queued: number
  /** Входящие конфликты по всем веткам. */
  conflicts: StoredConflict[]
  remote: Remote
  boot(): Promise<void>
  /** После входа (ключом) — перечитать сессию и данные. */
  signedIn(): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<void>
  /** Отправить очередь правок: по одному файлу, последовательно. 401 — остановиться и ждать входа. */
  flush(): Promise<void>
  /** Сверка открытой ветки и отправка очереди: старт, «онлайн», возврат на вкладку, кнопка индикатора. */
  syncNow(): Promise<void>
  refreshMe(): Promise<void>
  /** Открыть другую ветку: сразу её кэш с устройства, потом сверка с сервером. */
  switchBranch(name: string, notice?: string): Promise<void>
  /** Ветку удалили: стереть её кэш; если она была открыта — вернуться на main. */
  branchDeleted(name: string): Promise<void>
  dismissBranchNotice(): void
  /** Записать новый JSON-файл в открытую ветку. Повторяемо: тот же путь с тем же текстом — успех. */
  createFile(path: string, text: string): Promise<void>
  /**
   * Удалить файлы одним коммитом. Если ветку успели сдвинуть — сверка и одна повторная попытка.
   * also — правки других файлов тем же коммитом (например, отвязка идей удаляемого проекта); считаются
   * заново по свежим файлам при каждой попытке. Если всё не влезает в лимит коммита, первый коммит несёт
   * удаление и сколько влезет правок, остальные правки уходят следующими коммитами.
   */
  deleteFiles(paths: (tree: Tree) => string[], message: string, also?: (files: CachedFile[]) => CommitChange[]): Promise<void>
  /**
   * Правка полей проекта через очередь (ADR-004): сразу видна на экране и лежит в IndexedDB, пока не записана.
   * Одна ожидающая правка на файл — новая сливается с ней. Промис завершается, когда правка записана или
   * отложена (нет сети, нужен вход); если часть правки ушла во «Входящие конфликты» — ошибка QueueConflict.
   */
  saveProject(slug: string, patch: ProjectPatch): Promise<void>
  /**
   * Разрешить входящий конфликт файла: для каждого выбранного места — «моя», «из репо» или текст по кускам.
   * Выбор записывается в свежую версию файла; разрешённые места уходят из списка.
   */
  resolveConflict(branch: string, path: string, picks: { index: number; pick: ConflictPick }[]): Promise<void>
  /**
   * Правка settings.json. Правки идут по очереди; каждая применяется к версии файла на момент записи,
   * а если файл успели изменить — к свежей версии, один раз. Файла нет — он создаётся.
   */
  saveSettings(change: SettingsChange): Promise<void>
  /**
   * Удалить тег: из settings.json и со всех проектов ветки — одним коммитом. Если ветку успели сдвинуть,
   * изменения считаются заново по свежим файлам и отправляются ещё раз, один раз; иначе ничего не пишется.
   */
  deleteTag(id: string): Promise<void>
}

// Идущие сверки по веткам: повторный refresh той же ветки ждёт текущий, другой ветки — идёт параллельно.
const inFlight = new Map<string, Promise<void>>()

// Очередь записей настроек по файлам: следующая запись ждёт предыдущую.
const saving = new Map<string, Promise<void>>()

// Какие файлы держим в кэше как текст. Обложки грузятся отдельно (этап 8).
const isDataFile = (path: string) => /^(projects|ideas)\/[^/]+\.json$|^settings\.json$/.test(path)

export function errorText(e: unknown): string {
  if (isNetworkError(e)) return 'Нет связи с сервером хаба. Показываю данные с устройства.'
  if (e instanceof ApiError || e instanceof QueueConflict) return e.message
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
  queued: 0,
  conflicts: [],
  remote: serverRemote,

  async boot() {
    const branch = await getCurrentBranch().catch(() => MAIN)
    await loadQueue()
    const files = overlay(branch, await getCachedFiles(branch).catch(() => []))
    set({ branch })
    try {
      const me = await get().remote.me()
      set({ phase: 'ready', me, files })
      void requestPersistence()
      void get().syncNow()
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
    forgetQueue()
    await wipeDevice().catch(() => undefined)
    await wipeDrafts().catch(() => undefined) // черновики для обновления хаба (ADR-011)
    set({ phase: 'signedOut', me: null, branch: MAIN, branchNotice: null, files: [], tree: null, sync: 'idle', syncError: null, lastSync: null, queued: 0, conflicts: [] })
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

  flush() {
    running ??= drain()
    return running
  },

  async syncNow() {
    await get().refresh()
    await get().flush()
  },

  async switchBranch(name, notice) {
    if (name === get().branch) return
    await setCurrentBranch(name).catch(() => undefined)
    const files = overlay(name, await getCachedFiles(name).catch(() => []))
    set({ branch: name, files, tree: null, branchNotice: notice ?? null, sync: 'idle', syncError: null, lastSync: null })
    await get().refresh()
  },

  async branchDeleted(name) {
    await forgetBranch(name)
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

  async deleteFiles(pathsOf, message, also) {
    const { branch, remote } = get()
    const sent = new Set<string>()
    for (let attempt = 0, part = 1; ; ) {
      if (!get().tree) await get().refresh()
      const tree = get().tree
      if (!tree || get().branch !== branch) throw new ApiError(0, 'network', 'Нет связи с сервером хаба — удаление не отправлено')
      const paths = pathsOf(tree).filter((p) => tree.paths.includes(p))
      const extra = also ? also(get().files) : []
      if (!paths.length && !extra.length) return // уже удалено (например, на другом устройстве)
      // Правка, которую уже отправили и получили назад, — значит, она не применяется: не зацикливаемся.
      if (extra.some((c) => sent.has(c.path))) throw new ApiError(422, 'validation', 'Не удалось записать связанные файлы — обнови страницу и проверь данные')
      const changes: CommitChange[] = [...paths.map((path) => ({ path, text: null })), ...extra.slice(0, Math.max(0, COMMIT_LIMIT - paths.length))]
      try {
        const res = await remote.commit(branch, changes, tree.head, part === 1 ? message : `${message} (часть ${part})`)
        const written = changes.flatMap((c) => ('text' in c && c.text !== null ? [{ path: c.path, text: c.text }] : []))
        // Удалённому файлу ожидающая правка и конфликты больше не нужны.
        await forgetFiles(branch, paths)
        await applyWrite(branch, written.map((c) => ({ path: c.path, sha: res.shas[c.path] ?? '', text: c.text })), paths, res.head)
        for (const c of written) sent.add(c.path)
        if (changes.length === paths.length + extra.length) {
          void get().refresh()
          return
        }
        attempt = 0
        part++
      } catch (e) {
        // Ветку сдвинули после нашей сверки: перечитываем дерево и пробуем ещё раз, но только один.
        if (!(e instanceof ApiError && e.status === 409) || attempt > 0) throw e
        attempt++
        set({ tree: null })
      }
    }
  },

  async saveProject(slug, patch) {
    const branch = get().branch
    const path = `projects/${slug}.json`
    const k = key(branch, path)
    const mine = enqueue(branch, path, patch)
    await persistEntry(k)
    if (!persistAsked) {
      persistAsked = true
      void requestPersistence() // ADR-004: чтобы браузер не вычистил очередь при нехватке места; результат не важен
    }
    await get().flush()
    const problem = problems.get(k)
    if (problem && problem.seq >= mine) throw problem.error
  },

  async resolveConflict(branch, path, picks) {
    const k = key(branch, path)
    const rec = conflictMap.get(k)
    if (!rec) return
    const done = new Set(picks.map((p) => p.index))
    if (rec.deleted) {
      // Файл удалили в репо: «моя» — вернуть его с моей правкой, «из репо» — согласиться с удалением.
      if (picks.some((p) => p.pick === 'mine')) {
        const { sha } = await get().remote.putFile(branch, path, rec.deleted.mine)
        await applyWrite(branch, [{ path, sha, text: rec.deleted.mine }], [])
      }
      return dropConflict(k)
    }
    // Мою версию, которую не удалось слить или записать, записать нельзя — можно только отказаться от неё.
    if (rec.refused) return dropConflict(k)
    const ops = picks.flatMap((p) => {
      const item = rec.items[p.index]
      return item ? opsFor(item, p.pick) : []
    })
    if (ops.length) await writeOps(branch, path, ops)
    const left = conflictMap.get(k)
    if (!left) return
    const items = left.items.filter((_, i) => !done.has(i))
    if (!items.length) return dropConflict(k)
    const next: StoredConflict = { ...left, items, labels: left.labels.filter((_, i) => !done.has(i)) }
    conflictMap.set(k, next)
    publishConflicts()
    await persist(() => putConflict(next))
  },

  saveSettings(change) {
    const branch = get().branch
    const key = `${branch}
${SETTINGS}`
    const before = saving.get(key) ?? Promise.resolve()
    const done = before.catch(() => undefined).then(() => writeSettings(branch, change))
    saving.set(key, done)
    const cleanup = () => {
      if (saving.get(key) === done) saving.delete(key)
    }
    done.then(cleanup, cleanup)
    return done
  },

  deleteTag(id) {
    const branch = get().branch
    const key = `${branch}
${SETTINGS}`
    // В очереди настроек, после правок проектов этой ветки, которые уже идут: считаем от записанного.
    const before = [...saving.entries()].filter(([k]) => k === key).map(([, p]) => p.catch(() => undefined))
    // Правки проектов из очереди, которые уже идут, — дожидаемся, чтобы считать от записанного.
    if (running) before.push(running.catch(() => undefined))
    const done = Promise.all(before).then(() => untagAll(branch, id))
    saving.set(key, done)
    const cleanup = () => {
      if (saving.get(key) === done) saving.delete(key)
    }
    done.then(cleanup, cleanup)
    return done
  },
}))

/** Сколько файлов сервер принимает в одном коммите (worker/write.ts, COMMIT_LIMIT). */
export const COMMIT_LIMIT = 100

async function untagAll(branch: string, id: string): Promise<void> {
  const session = () => useSession.getState()
  for (let attempt = 0; ; attempt++) {
    if (!session().tree) await session().refresh()
    const tree = session().tree
    if (!tree || session().branch !== branch) throw new ApiError(0, 'network', 'Нет связи с сервером хаба — тег не удалён')

    const changes: { path: string; text: string }[] = []
    const settings = currentSettings(branch)
    if (settings.sha !== undefined) {
      const next = removeTag(id)(structuredClone(settings.data))
      if (!validateSettings(next)) throw new ApiError(422, 'validation', 'Настройки не прошли проверку схемой — тег не удалён')
      const text = serialize(next)
      if (text !== serialize(settings.data)) changes.push({ path: SETTINGS, text })
    }
    const untag = untagProjects(session().files, id)
    if (untag.locked.length) {
      throw new ApiError(422, 'validation', `Тег не удалён: ${untag.locked.join(', ')} — в новой версии формата, хаб такие файлы не правит`)
    }
    changes.push(...untag.changes)
    if (!changes.length) return // тега уже нет нигде (например, удалили на другом устройстве)
    if (changes.length > COMMIT_LIMIT) {
      // Сколько проектов влезает рядом с settings.json — если он в коммит не входит, лимит целиком их.
      const room = COMMIT_LIMIT - (changes.length - untag.changes.length)
      throw new ApiError(413, 'payload_too_large', `Тег стоит в ${untag.changes.length} проектах — за один раз хаб меняет не больше ${room}. Сними его с части проектов вручную.`)
    }

    try {
      const res = await session().remote.commit(branch, changes, tree.head, `Хаб: удалить тег ${id}`)
      await applyWrite(branch, changes.map((c) => ({ path: c.path, sha: res.shas[c.path] ?? '', text: c.text })), [], res.head)
      void session().refresh()
      return
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e
      if (attempt > 0) throw new ApiError(409, 'conflict', 'Данные успели измениться на другом устройстве — тег не удалён, ничего не записано. Попробуй ещё раз.')
      // Ветку сдвинули после нашей сверки: дочитываем свежие файлы и считаем изменения заново.
      useSession.setState({ tree: null })
    }
  }
}

const SETTINGS = 'settings.json'

/** Текущий settings.json открытой ветки. Файла нет — пустые настройки без sha (запись создаст файл). */
function currentSettings(branch: string): { sha?: string; data: SettingsData } {
  const state = useSession.getState()
  if (state.branch !== branch) throw new ApiError(0, 'network', 'Открыта другая ветка — правка не отправлена')
  const file = state.files.find((f) => f.path === SETTINGS)
  if (!file) return { data: { schemaVersion: SCHEMA_VERSIONS.settings, tags: [] } }
  const parsed = parseFile(SETTINGS, file.sha, file.text)
  // Битый файл не перезаписываем: в нём могут быть данные, которые человек правил руками.
  if (!parsed.ok) throw new ApiError(422, 'validation', `settings.json не читается: ${parsed.error}. Поправь файл в репо данных.`)
  if (parsed.readOnly) throw new ApiError(422, 'validation', parsed.reason)
  return { sha: file.sha, data: structuredClone(parsed.data) as SettingsData }
}

async function writeSettings(branch: string, change: SettingsChange): Promise<void> {
  const { remote } = useSession.getState()
  const put = async (from: { sha?: string; data: SettingsData }) => {
    const before = serialize(from.data)
    const next = change(structuredClone(from.data))
    if (!validateSettings(next)) throw new ApiError(422, 'validation', 'Настройки не прошли проверку схемой — не сохранено')
    const text = serialize(next)
    if (text === before) return // правка ничего не меняет (например, уже применена)
    const { sha } = await remote.putFile(branch, SETTINGS, text, from.sha)
    await applyWrite(branch, [{ path: SETTINGS, sha, text }], [])
  }
  const base = currentSettings(branch)
  try {
    await put(base)
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e
    // Файл изменили (или создали) в другом месте: дочитываем свежую версию и накладываем правку на неё.
    await useSession.getState().refresh()
    let fresh = currentSettings(branch)
    if (fresh.sha === base.sha) {
      await useSession.getState().refresh()
      fresh = currentSettings(branch)
    }
    if (fresh.sha === base.sha) throw e
    await put(fresh)
  }
}

/** Сразу показать результат записи: кэш на устройстве, файлы на экране и дерево ветки. */
export async function applyWrite(branch: string, changed: CachedFile[], removed: string[], head?: string): Promise<void> {
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
  useSession.setState({ files: overlay(branch, [...files.values()]), tree })
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
    useSession.setState({ files: overlay(branch, [...next.values()]), tree: { head, paths: remoteFiles.map((f) => f.path) }, sync: 'idle', lastSync: new Date() })
    if (!useSession.getState().me) void useSession.getState().refreshMe() // запускались без сети — теперь узнаём сессию
  } catch (e) {
    if (!current()) return
    const status = e instanceof ApiError ? e.status : -1
    // Ветку удалили на другом устройстве или на GitHub — возвращаемся на main, кэш ветки больше не нужен.
    if (status === 404 && branch !== MAIN) {
      await forgetBranch(branch)
      await useSession.getState().switchBranch(MAIN, `Ветки «${branch}» больше нет в репо данных — открыта main.`)
      return
    }
    useSession.setState({
      sync: status === 401 ? 'sessionExpired' : status === 0 ? 'offline' : 'error',
      syncError: status === 401 ? 'Сессия закончилась, войди снова.' : errorText(e),
    })
  }
}

// ---------- Очередь правок (ADR-004) и входящие конфликты (ADR-004 шаг 5, ADR-010) ----------
// Память — зеркало IndexedDB: правка сначала ложится сюда (экран видит её сразу), потом в базу.
// Записи в базу идут одной цепочкой, чтобы порядок сохранения совпадал с порядком правок.

/** Часть правки ушла во «Входящие конфликты» или правку не удалось записать. */
export class QueueConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueConflict'
  }
}

interface Live {
  edit: QueuedEdit
  /** Растёт с каждой правкой, влитой в ожидающую: так видно, что во время отправки пришло новое. */
  rev: number
}

const key = (branch: string, path: string) => `${branch}\n${path}`
const queue = new Map<string, Live>()
const conflictMap = new Map<string, StoredConflict>()
/** Последняя проблема с файлом: seq — номер правки на момент проблемы (saveProject сообщает только о своих). */
const problems = new Map<string, { seq: number; error: QueueConflict }>()
let seq = 0
let persistAsked = false
let running: Promise<void> | null = null
let dbChain: Promise<void> = Promise.resolve()

const RETRY_FIRST = 5_000
const RETRY_MAX = 5 * 60_000
let autoRetry = false
let retryDelay = RETRY_FIRST
let retryTimer: ReturnType<typeof setTimeout> | null = null

function persist(op: () => Promise<void>): Promise<void> {
  dbChain = dbChain.then(op).catch(() => undefined)
  return dbChain
}

/** Сохранить в базу текущее состояние правки файла (или её отсутствие). */
function persistEntry(k: string): Promise<void> {
  return persist(() => {
    const live = queue.get(k)
    const [branch = '', path = ''] = k.split('\n')
    return live ? putQueued(live.edit) : deleteQueued(branch, path)
  })
}

function publish() {
  useSession.setState({ queued: queue.size })
}

function publishConflicts() {
  useSession.setState({ conflicts: [...conflictMap.values()].sort((a, b) => a.at.localeCompare(b.at)) })
}

/** Поднять очередь и конфликты с устройства (старт, вход). Правки, которые уже в памяти, не затираются. */
async function loadQueue(): Promise<void> {
  await dbChain
  for (const edit of await getQueue().catch(() => [] as QueuedEdit[])) {
    const k = key(edit.branch, edit.path)
    if (!queue.has(k)) queue.set(k, { edit, rev: 0 })
  }
  for (const c of await getConflicts().catch(() => [] as StoredConflict[])) {
    const k = key(c.branch, c.path)
    if (!conflictMap.has(k)) conflictMap.set(k, c)
  }
  publish()
  publishConflicts()
}

/** «Выйти»: очередь и конфликты стираются вместе с устройством. */
function forgetQueue() {
  queue.clear()
  conflictMap.clear()
  problems.clear()
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDelay = RETRY_FIRST
}

/** Ветку удалили: её кэш, очередь и конфликты больше некуда писать. */
async function forgetBranch(branch: string): Promise<void> {
  for (const [k, live] of queue) if (live.edit.branch === branch) queue.delete(k)
  for (const [k, c] of conflictMap) if (c.branch === branch) conflictMap.delete(k)
  publish()
  publishConflicts()
  await persist(() => dropBranchCache(branch))
}

/** Файлы удалили из ветки: их правки и конфликты больше не нужны. */
async function forgetFiles(branch: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const k = key(branch, path)
    const had = queue.delete(k)
    if (had) await persistEntry(k)
    if (conflictMap.delete(k)) await persist(() => deleteConflict(branch, path))
  }
  publish()
  publishConflicts()
}

/** Файлы ветки для экрана: у файлов с ожидающей правкой — моя версия. */
function overlay(branch: string, files: CachedFile[]): CachedFile[] {
  if (!queue.size) return files
  return files.map((f) => {
    const live = queue.get(key(branch, f.path))
    return live ? { ...f, text: live.edit.text } : f
  })
}

/** Показать на экране текущую версию файла из очереди (если ветка открыта). */
function showEdit(branch: string) {
  const state = useSession.getState()
  if (state.branch !== branch) return
  useSession.setState({ files: overlay(branch, state.files) })
}

/** Вернуть на экран версию файла с устройства: правку убрали из очереди, не записав. */
async function showCached(branch: string, path: string): Promise<void> {
  const cached = (await getCachedFiles(branch).catch(() => [] as CachedFile[])).find((f) => f.path === path)
  const state = useSession.getState()
  if (state.branch !== branch) return
  const files = state.files.filter((f) => f.path !== path)
  useSession.setState({ files: overlay(branch, cached ? [...files, cached] : files) })
}

/** Моя версия файла проекта: базовая копия с правкой, нормализованная (ADR-009). */
function render(path: string, baseSha: string, baseText: string, patch: ProjectPatch): string {
  const parsed = parseFile(path, baseSha, baseText)
  if (!parsed.ok) throw new ApiError(422, 'validation', `Файл не читается: ${parsed.error}`)
  if (parsed.readOnly) throw new ApiError(422, 'validation', parsed.reason)
  const prev = parsed.data as WithUnknown<Project>
  return serialize(normalizeProject(prev, applyEdit(prev, patch) as WithUnknown<Project>))
}

/** Положить правку в очередь: новая правка файла сливается с ожидающей, база остаётся прежней. Возвращает номер правки. */
function enqueue(branch: string, path: string, patch: ProjectPatch): number {
  const k = key(branch, path)
  const live = queue.get(k)
  if (live) {
    const merged = mergePatch(live.edit.patch, patch)
    live.edit = { ...live.edit, patch: merged, text: render(path, live.edit.baseSha, live.edit.baseText, merged) }
    live.rev++
  } else {
    const state = useSession.getState()
    if (state.branch !== branch) throw new ApiError(0, 'network', 'Открыта другая ветка — правка не сохранена')
    const file = state.files.find((f) => f.path === path)
    if (!file) throw new ApiError(404, 'not_found', 'Проекта больше нет в этой ветке')
    const text = render(path, file.sha, file.text, patch)
    queue.set(k, { edit: { branch, path, baseSha: file.sha, baseText: file.text, patch, text, queuedAt: nowIso() }, rev: 0 })
  }
  showEdit(branch)
  publish()
  return ++seq
}

/** Разбор цикла отправки: по одному файлу, по порядку правок. */
async function drain(): Promise<void> {
  await null // running должен быть присвоен до того, как цикл сможет закончиться
  try {
    for (;;) {
      const state = useSession.getState()
      if (state.phase !== 'ready' || state.sync === 'sessionExpired') return
      const next = [...queue.values()].sort((a, b) => a.edit.queuedAt.localeCompare(b.edit.queuedAt))[0]
      if (!next) {
        retryDelay = RETRY_FIRST
        return
      }
      const r = await send(next)
      if (r === 'auth') return // ждём входа: signedIn → boot → отправка
      if (r === 'later') {
        scheduleRetry()
        return
      }
    }
  } finally {
    running = null
  }
}

function scheduleRetry() {
  if (!autoRetry || !queue.size || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void useSession.getState().syncNow()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX)
}

type SendResult = 'next' | 'later' | 'auth'

async function send(live: Live): Promise<SendResult> {
  const { branch, path } = live.edit
  const { remote } = useSession.getState()
  const rev = live.rev
  const sent = live.edit
  let sha: string
  try {
    sha = (await remote.putFile(branch, path, sent.text, sent.baseSha)).sha
  } catch (e) {
    // Файл изменили (или удалили) в другом месте — перечитываем и сливаем (ADR-004, шаги 1–4).
    if (e instanceof ApiError && ((e.status === 409 && e.code !== STALE_BUILD) || e.status === 404)) {
      try {
        await mergeAndSend(live)
        return 'next'
      } catch (err) {
        return failed(live, err)
      }
    }
    return failed(live, e)
  }
  await written(live, rev, sha, sent.text)
  return 'next'
}

/** Правка записана как есть. Если за это время пришли новые правки, они остаются ждать — уже от записанной версии. */
async function written(live: Live, rev: number, sha: string, text: string): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  if (queue.get(k) === live) {
    if (live.rev === rev) queue.delete(k)
    else live.edit = { ...live.edit, baseSha: sha, baseText: text, text: render(path, sha, text, live.edit.patch) }
  }
  retryDelay = RETRY_FIRST
  await persistEntry(k)
  publish()
  await applyWrite(branch, [{ path, sha, text }], [])
}

/** Свежая версия файла ветки с сервера; null — файла в ветке нет. */
async function readFresh(branch: string, path: string): Promise<CachedFile | null> {
  const { remote } = useSession.getState()
  const { files } = await remote.listFiles(branch)
  const f = files.find((x) => x.path === path)
  if (!f) return null
  return { path, sha: f.sha, text: await remote.readBlobText(f.sha) }
}

function parseDoc(text: string, what: string): JsonObject {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new MergeRefused(`${what} не читается как JSON`)
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new MergeRefused(`${what} — не JSON-объект`)
  return v as JsonObject
}

/** Нормализовать слитый файл и проверить его схемой до отправки. */
function finish(path: string, prev: JsonObject, next: JsonObject): JsonObject {
  const out = normalizeProject(prev as WithUnknown<Project>, next as WithUnknown<Project>) as JsonObject
  const parsed = parseFile(path, '', serialize(out))
  if (!parsed.ok) throw new MergeRefused(`после слияния файл не проходит проверку: ${parsed.error}`)
  return out
}

/** Файл из репо так, как хаб записал бы его без правок: нормализованный (ADR-009). */
const asWritten = (doc: JsonObject) => normalizeProject(doc as WithUnknown<Project>, doc as WithUnknown<Project>) as JsonObject

/**
 * Конфликт версий (ADR-004): перечитать файл; тот же sha — ложный конфликт, повтор без слияния; иначе трёхстороннее
 * слияние сырых файлов (ADR-010). Слившееся записывается, спорные места — во «Входящие конфликты».
 */
async function mergeAndSend(live: Live): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  const { remote } = useSession.getState()
  for (let attempt = 0; attempt < 3; attempt++) {
    const rev = live.rev
    const mine = live.edit
    const fresh = await readFresh(branch, path)
    if (!fresh) return recordDeleted(live)
    if (fresh.sha === mine.baseSha) {
      // Ветку сдвинул коммит в другой файл: наш файл тот же, повторяем запись как есть.
      try {
        const { sha } = await remote.putFile(branch, path, mine.text, mine.baseSha)
        return written(live, rev, sha, mine.text)
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
        throw e
      }
    }
    const theirs = parseDoc(fresh.text, 'Файл в репо')
    const local = parseDoc(mine.text, 'Моя версия')
    const { merged, conflicts } = merge('project', parseDoc(mine.baseText, 'Базовая копия'), local, theirs)
    const next = finish(path, theirs, merged)
    let saved: CachedFile = fresh
    // Моя правка уже в репо (ответ прошлой записи потерялся) — писать нечего, кроме времени и нормализации.
    if (!sameContent(next, asWritten(theirs))) {
      const text = serialize(next)
      try {
        saved = { path, sha: (await remote.putFile(branch, path, text, fresh.sha)).sha, text }
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
        throw e
      }
    }
    if (conflicts.length) await recordConflict(branch, path, { items: conflicts, local, remote: theirs })
    // Новые правки, пришедшие за это время, остаются в очереди от прежней базы: следующая отправка сольёт их снова.
    if (queue.get(k) === live && live.rev === rev) queue.delete(k)
    retryDelay = RETRY_FIRST
    await persistEntry(k)
    publish()
    await applyWrite(branch, [saved], [])
    return
  }
  throw new ApiError(409, 'conflict', 'Файл меняется на другом устройстве прямо сейчас — отправлю позже')
}

/** Ошибка отправки: сеть и сбои сервера — ждём и повторяем; 401 — ждём входа; отказ по существу — во «Входящие». */
async function failed(live: Live, e: unknown): Promise<SendResult> {
  if (e instanceof MergeRefused) {
    await refuse(live, e.message)
    return 'next'
  }
  if (!(e instanceof ApiError)) {
    useSession.setState({ sync: 'error', syncError: errorText(e) })
    return 'later'
  }
  if (e.status === 401) {
    useSession.setState({ sync: 'sessionExpired', syncError: 'Сессия закончилась, войди снова.' })
    return 'auth'
  }
  const transient = e.status === 0 || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500 || e.code === STALE_BUILD
  if (transient) {
    useSession.setState({ sync: e.status === 0 ? 'offline' : 'error', syncError: errorText(e) })
    return 'later'
  }
  // Сервер отказал по существу (схема, размер, путь): повтор не поможет. Правку не теряем — она во «Входящих».
  await refuse(live, e.message)
  return 'next'
}

/** Правку не удалось слить или записать: убрать из очереди, показать во «Входящих» целиком. */
async function refuse(live: Live, reason: string): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  if (queue.get(k) === live) queue.delete(k)
  await persistEntry(k)
  publish()
  await recordConflict(branch, path, { refused: { reason, mine: live.edit.text } })
  await showCached(branch, path)
}

/** Файл удалили в репо, а у меня правка: выбор — вернуть мою версию или согласиться с удалением. */
async function recordDeleted(live: Live): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  if (queue.get(k) === live) queue.delete(k)
  await persistEntry(k)
  publish()
  await recordConflict(branch, path, { deleted: { mine: live.edit.text } })
  await applyWrite(branch, [], [path])
}

type Problem =
  | { items: MergeConflict[]; local: JsonObject; remote: JsonObject }
  | { refused: { reason: string; mine: string } }
  | { deleted: { mine: string } }

function titleOf(...texts: (string | JsonObject | undefined)[]): string | undefined {
  for (const t of texts) {
    let doc: unknown = t
    if (typeof t === 'string') {
      try {
        doc = JSON.parse(t)
      } catch {
        continue
      }
    }
    const title = doc && typeof doc === 'object' ? (doc as { title?: unknown }).title : undefined
    if (typeof title === 'string' && title.trim()) return title
  }
  return undefined
}

/** Записать конфликт файла. Спорные места того же файла, которые ещё не разобраны, остаются; одинаковые — заменяются. */
async function recordConflict(branch: string, path: string, problem: Problem): Promise<void> {
  const k = key(branch, path)
  const prev = conflictMap.get(k)
  const slug = path.replace(/^projects\/|\.json$/g, '')
  const rec: StoredConflict = {
    branch,
    path,
    title: prev?.title ?? slug,
    at: nowIso(),
    items: prev?.items ?? [],
    labels: prev?.labels ?? [],
  }
  let message: string
  if ('items' in problem) {
    rec.title = titleOf(problem.remote, problem.local) ?? rec.title
    const byPath = new Map(rec.items.map((it, i) => [it.path.join('\n'), { it, label: rec.labels[i] ?? '' }]))
    for (const it of problem.items) byPath.set(it.path.join('\n'), { it, label: conflictLabel(it, problem.local, problem.remote) })
    rec.items = [...byPath.values()].map((x) => x.it)
    rec.labels = [...byPath.values()].map((x) => x.label)
    if (prev?.refused) rec.refused = prev.refused
    if (prev?.deleted) rec.deleted = prev.deleted
    message = `Эти поля одновременно поменяли в другом месте: ${problem.items.map((it) => conflictLabel(it, problem.local, problem.remote)).join(', ')}. Остальное записано, выбор — во «Входящих конфликтах».`
  } else if ('refused' in problem) {
    rec.title = titleOf(problem.refused.mine) ?? rec.title
    rec.refused = problem.refused
    message = `Правка не записана: ${problem.refused.reason}. Она сохранена во «Входящих конфликтах».`
  } else {
    rec.title = titleOf(problem.deleted.mine) ?? rec.title
    rec.deleted = problem.deleted
    message = 'Проект удалили в другом месте. Твоя правка — во «Входящих конфликтах»: можно вернуть проект или согласиться с удалением.'
  }
  conflictMap.set(k, rec)
  problems.set(k, { seq, error: new QueueConflict(message) })
  publishConflicts()
  await persist(() => putConflict(rec))
}

async function dropConflict(k: string): Promise<void> {
  const rec = conflictMap.get(k)
  if (!rec) return
  conflictMap.delete(k)
  publishConflicts()
  await persist(() => deleteConflict(rec.branch, rec.path))
}

/** Записать выбор в свежую версию файла. Если файл успели изменить ещё раз — перечитать и повторить. */
async function writeOps(branch: string, path: string, ops: Parameters<typeof applyOps>[1]): Promise<void> {
  const { remote } = useSession.getState()
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await readFresh(branch, path)
    if (!fresh) throw new ApiError(404, 'not_found', 'Файла уже нет в репо — выбор некуда записать')
    const doc = parseDoc(fresh.text, 'Файл в репо')
    const changed = applyOps(doc, ops)
    if (typeof doc.updatedAt === 'string') changed.updatedAt = nowIso()
    let next: JsonObject
    try {
      next = finish(path, doc, changed)
    } catch (e) {
      throw new ApiError(422, 'validation', e instanceof Error ? e.message : 'Файл не проходит проверку')
    }
    if (sameContent(next, asWritten(doc))) return
    const text = serialize(next)
    try {
      const { sha } = await remote.putFile(branch, path, text, fresh.sha)
      await applyWrite(branch, [{ path, sha, text }], [])
      return
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
      throw e
    }
  }
  throw new ApiError(409, 'conflict', 'Файл снова изменился — попробуй ещё раз')
}

/**
 * Когда отправлять очередь (ADR-004): вернулись на вкладку, появилась сеть — сверка и отправка; после неудачи —
 * повтор с нарастающей паузой 5 с → 5 мин. Старт и вход запускают отправку сами (boot). Возвращает отписку.
 */
export function installSyncTriggers(
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState: string } = document,
): () => void {
  const run = () => void useSession.getState().syncNow()
  const onVisible = () => {
    if (doc.visibilityState === 'visible') run()
  }
  doc.addEventListener('visibilitychange', onVisible)
  win.addEventListener('online', run)
  autoRetry = true
  return () => {
    doc.removeEventListener('visibilitychange', onVisible)
    win.removeEventListener('online', run)
    autoRetry = false
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** Только для тестов: забыть очередь в памяти, как при перезапуске приложения. */
export function resetQueueMemory(): void {
  forgetQueue()
  persistAsked = false
  running = null
  seq = 0
  useSession.setState({ queued: 0, conflicts: [] })
}
