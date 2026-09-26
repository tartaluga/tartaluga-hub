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
  getConflict,
  getConflicts,
  getCurrentBranch,
  getQueue,
  getQueued,
  onDbBlocked,
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
import { merge, MergeRefused, type Json, type JsonObject, type MergeConflict } from '../data/merge'
import { applyOps, conflictLabel, heldValue, opsFor, sameContent, sameValue, valueAt, type ConflictOp, type ConflictPick } from '../data/conflicts'
import type { Project } from '../schema/types'
import { normalizeProject } from '../data/normalize'
import { validateSettings } from '../schema/validators.js'
import { removeTag, type SettingsChange, type SettingsData } from '../components/TagEditor.model'
import { untagProjects } from '../data/projects'
import { applyEdit, mergePatch, type ProjectPatch } from '../data/editProject'
import { plural } from '../lib/plural'

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
  /** Беда с хранилищем устройства: правка не легла в IndexedDB или обновление базы ждёт другие вкладки. */
  deviceError: string | null
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
  /**
   * Перед «Влить» и удалением ветки: отправить очередь. Если у ветки остались неотправленные правки или
   * входящие конфликты — ошибка с понятным текстом: вливать и удалять нельзя, пока их не разберут.
   */
  settleBranch(name: string): Promise<void>
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
  deviceError: null,
  remote: serverRemote,

  async boot() {
    const branch = await getCurrentBranch().catch(() => MAIN)
    await reloadFromDevice()
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
    set({ phase: 'signedOut', me: null, branch: MAIN, branchNotice: null, files: [], tree: null, sync: 'idle', syncError: null, lastSync: null, queued: 0, conflicts: [], deviceError: null })
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
    running ??= drainLocked()
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

  async settleBranch(name) {
    await reloadFromDevice() // правки и конфликты ветки, записанные другой вкладкой, тоже считаются
    await get().flush()
    const edits = [...queue.values()].filter((l) => l.edit.branch === name).length
    const disputes = [...conflictMap.values()]
      .filter((c) => c.branch === name)
      .reduce((n, c) => n + c.items.length + (c.refused || c.deleted ? 1 : 0), 0)
    if (!edits && !disputes) return
    const parts = [
      ...(edits ? [`${edits} ${plural(edits, 'неотправленная правка', 'неотправленные правки', 'неотправленных правок')}`] : []),
      ...(disputes ? [`${disputes} ${plural(disputes, 'конфликт', 'конфликта', 'конфликтов')}`] : []),
    ]
    const how = [...(edits ? ['правки уйдут, когда будет связь и вход'] : []), ...(disputes ? ['конфликты — во «Входящих конфликтах»'] : [])]
    throw new ApiError(423, 'queue_pending', `В ветке «${name}» ещё ${parts.join(' и ')} — разбери сначала: ${how.join(', ')}.`)
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
    if (rec.deleted || rec.refused) {
      // Файл удалили в репо: «моя» — вернуть его с моей правкой, «из репо» — согласиться с удалением.
      // Мою версию, которую не удалось слить или записать, записать нельзя — можно только отказаться от неё.
      const restore = !!rec.deleted && picks.some((p) => p.pick === 'mine')
      if (restore) {
        const { sha } = await get().remote.putFile(branch, path, rec.deleted!.mine)
        await applyWrite(branch, [{ path, sha, text: rec.deleted!.mine }], [])
      }
      // Выбор снимает только удаление или отказ: спорные места файла остаются. Согласились с удалением — файла нет, выбирать не в чем.
      await updateConflict(branch, path, (cur) => {
        if (!cur) return undefined
        if (rec.deleted && !restore) return null
        const { deleted: _deleted, refused: _refused, ...rest } = cur
        return rest.items.length ? rest : null
      })
      return
    }
    const chosen = picks.flatMap((p) => {
      const item = rec.items[p.index]
      return item ? [{ index: p.index, item, pick: p.pick }] : []
    })
    const stale = chosen.some((c) => opsFor(c.item, c.pick).length) ? await writeOps(branch, path, chosen) : new Map<number, Json | undefined>()
    // Разобранное снимается со свежей записи на устройстве: другая вкладка могла дописать в неё спорные места.
    // Место узнаём по пути и содержимому, а не по номеру — номера в свежей записи могли сдвинуться.
    const byPath = new Map(chosen.map((c) => [c.item.path.join('\n'), c]))
    await updateConflict(branch, path, (cur) => {
      if (!cur) return undefined
      const items: MergeConflict[] = []
      const labels: string[] = []
      cur.items.forEach((it, i) => {
        const label = cur.labels[i] ?? ''
        const c = byPath.get(it.path.join('\n'))
        if (!c || JSON.stringify(c.item) !== JSON.stringify(it)) {
          items.push(it)
          labels.push(label)
        } else if (stale.has(c.index)) {
          const again = changedAgain(it, label, stale.get(c.index))
          if (again) {
            items.push(again.item)
            labels.push(again.label)
          }
        }
      })
      return items.length || cur.refused || cur.deleted ? { ...cur, items, labels } : null
    })
    if (stale.size) throw new QueueConflict(chosen.length > stale.size ? PARTLY_WRITTEN : NOTHING_WRITTEN)
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
  /** Правки с базовой копии по порядку (edit.patch — их слияние). Первые saved уже лежат в IndexedDB. */
  patches: ProjectPatch[]
  saved: number
  /** В памяти есть то, чего ещё нет в IndexedDB. */
  dirty: boolean
  /** Растёт, когда правку целиком заменили записью другой вкладки: тогда patches считаются заново. */
  epoch: number
}

/** Снимок правки перед отправкой: по нему после записи видно, что пришло за это время. */
interface Snap {
  rev: number
  epoch: number
  /** Сколько правок было в patches. */
  n: number
  /** Какая запись IndexedDB отправляется: после записи удаляем только её. */
  id: string | undefined
}

const key = (branch: string, path: string) => `${branch}\n${path}`
const queue = new Map<string, Live>()
/** id записи очереди в IndexedDB, которую эта вкладка записала или прочла последней. Другой id — запись переписала другая вкладка. */
const storedIds = new Map<string, string>()
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

// Несколько вкладок хаба на одном устройстве (ADR-004): у каждой очередь в памяти, общая — в IndexedDB.
// Запись в очередь и разбор после отправки идут под блокировкой; другие вкладки узнают о переменах по BroadcastChannel.
const QUEUE_LOCK = 'hub-queue'
/** Отдельная блокировка на отправку: под ней берётся QUEUE_LOCK (Web Locks не повторно входимы). */
const SEND_LOCK = 'hub-queue-send'
let channel: BroadcastChannel | null = null

export const DEVICE_WRITE_FAILED = 'Правка не сохранилась на устройстве — не закрывай хаб, пока она не отправится.'
export const DEVICE_READ_FAILED = 'Не удалось прочитать очередь правок с устройства — перезапусти хаб; то, что на экране, не потеряно.'
export const NOTHING_WRITTEN = 'Пока ты выбирал, это место в репо изменили ещё раз. Ничего не записано: на экране новое значение — выбери снова.'
export const PARTLY_WRITTEN = 'Часть выбора записана. Остальные места в репо изменили ещё раз, пока ты выбирал: на экране новое значение — выбери снова.'
export const DB_BLOCKED = 'Хаб обновляется: закрой другие вкладки хаба, чтобы продолжить.'

onDbBlocked((blocked) => {
  if (blocked) useSession.setState({ deviceError: DB_BLOCKED })
  else if (useSession.getState().deviceError === DB_BLOCKED) useSession.setState({ deviceError: null })
})

/** Под блокировкой очереди, если браузер умеет Web Locks; иначе как есть (одна вкладка). */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Partial<Navigator>).locks
  return locks?.request ? (locks.request(QUEUE_LOCK, fn) as Promise<T>) : fn()
}

/**
 * Отправляет одна вкладка за раз. Если отправку держит другая вкладка, дождаться её и сперва перечитать очередь
 * с устройства: то, что та вкладка уже отправила, второй раз не уходит.
 */
function drainLocked(): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Partial<Navigator>).locks
  if (!locks?.request) return drain()
  return locks.request(SEND_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) return drain()
    return locks.request(SEND_LOCK, async () => {
      await reloadFromDevice()
      return drain()
    })
  }) as Promise<void>
}

const idOf = (edit: QueuedEdit) => edit.id ?? ''
const newId = () => crypto.randomUUID()

/**
 * Записи в базу идут одной цепочкой, чтобы порядок сохранения совпадал с порядком правок. Ошибку записи не глотаем
 * молча: правка остаётся в памяти и уходит на сервер, а индикатор говорит, что на устройстве её нет.
 * op возвращает false, если ничего не записал, — тогда другим вкладкам сообщать не о чем.
 */
function persist(op: () => Promise<void | boolean>, failText = DEVICE_WRITE_FAILED): Promise<void> {
  dbChain = dbChain.then(op).then(
    (wrote) => {
      if (wrote !== false) channel?.postMessage('queue')
      const { deviceError } = useSession.getState()
      if (deviceError === failText && (failText === DEVICE_READ_FAILED || ![...queue.values()].some((l) => l.dirty))) useSession.setState({ deviceError: null })
    },
    () => useSession.setState({ deviceError: failText }),
  )
  return dbChain
}

/** Свести правку файла в памяти с записью в IndexedDB. sentId — запись, которую только что отправили. */
function persistEntry(k: string, sentId?: string): Promise<void> {
  return persist(() => withLock(() => reconcile(k, sentId)))
}

/**
 * Под блокировкой: запись в IndexedDB — общая для вкладок. Если её переписала другая вкладка, в ней уже всё, что
 * эта вкладка записала раньше: мои ещё не записанные правки ложатся поверх неё, база — самая ранняя.
 * Иначе запись приводится к памяти; удаляется только та запись, которую эта вкладка знает (или отправила).
 */
async function reconcile(k: string, sentId?: string): Promise<boolean> {
  const [branch = '', path = ''] = k.split('\n')
  let stored = await getQueued(branch, path)
  const live = queue.get(k)
  const gone = goneAt.get(branch)
  if (gone !== undefined) {
    // Ветку удалили: правки, сделанные до этого, не возвращаются в базу.
    let wrote = false
    if (stored && stored.queuedAt <= gone) {
      await deleteQueued(branch, path)
      stored = undefined
      wrote = true
    }
    if (live && live.edit.queuedAt <= gone && queue.get(k) === live) {
      queue.delete(k)
      storedIds.delete(k)
      publish()
    }
    if (!stored && !queue.has(k)) {
      storedIds.delete(k)
      return wrote
    }
  }
  const known = stored !== undefined && (idOf(stored) === storedIds.get(k) || (sentId !== undefined && idOf(stored) === sentId))
  if (!stored || known) {
    if (!live) {
      if (!stored) return false
      await deleteQueued(branch, path)
      storedIds.delete(k)
      return true
    }
    if (!live.dirty) {
      if (stored) return false
      // Запись убрала другая вкладка: правку она уже отправила (или ветку удалили).
      queue.delete(k)
      storedIds.delete(k)
      publish()
      return false
    }
    return write(k, live)
  }
  const pending = live ? live.patches.slice(live.saved) : []
  const from = live && !storedIds.has(k) && live.edit.queuedAt < stored.queuedAt ? live.edit : stored
  const patch = pending.reduce((a, p) => mergePatch(a, p), stored.patch)
  const changed = pending.length > 0 || from !== stored
  const edit: QueuedEdit = changed
    ? { ...stored, baseSha: from.baseSha, baseText: from.baseText, queuedAt: from.queuedAt, patch, text: render(path, from.baseSha, from.baseText, patch), id: newId() }
    : stored
  if (changed) await putQueued(edit)
  storedIds.set(k, idOf(edit))
  // Правки, пришедшие в эту вкладку, пока шла запись, остаются сверху.
  const now = queue.get(k)
  const later = live && now === live ? now.patches.slice(live.saved + pending.length) : []
  const mine = later.reduce((a, p) => mergePatch(a, p), edit.patch)
  const next: Live = {
    edit: later.length ? { ...edit, patch: mine, text: render(path, edit.baseSha, edit.baseText, mine) } : edit,
    rev: (now?.rev ?? 0) + 1,
    patches: [edit.patch, ...later],
    saved: 1,
    dirty: later.length > 0,
    epoch: (now?.epoch ?? 0) + 1,
  }
  if (now) Object.assign(now, next)
  else queue.set(k, next)
  publish()
  showEdit(branch)
  return changed
}

async function write(k: string, live: Live): Promise<boolean> {
  const n = live.patches.length
  const { rev, epoch } = live
  const edit: QueuedEdit = { ...live.edit, id: newId() }
  await putQueued(edit)
  storedIds.set(k, edit.id!)
  if (queue.get(k) === live && live.epoch === epoch) {
    live.saved = n
    if (live.rev === rev) live.dirty = false
  }
  return true
}

/**
 * Поднять очередь и конфликты с устройства: старт, вход, сообщение другой вкладки. Правки, которых ещё нет
 * в базе, не теряются — ложатся поверх записанного.
 */
function reloadFromDevice(): Promise<void> {
  return persist(() =>
    withLock(async () => {
      const records = await getQueue()
      const keys = new Set([...queue.keys(), ...records.map((r) => key(r.branch, r.path))])
      let wrote = false
      for (const k of keys) if (await reconcile(k)) wrote = true
      const conflicts = await getConflicts()
      conflictMap.clear()
      for (const c of conflicts) conflictMap.set(key(c.branch, c.path), c)
      publish()
      publishConflicts()
      void showDevice()
      return wrote
    }),
    DEVICE_READ_FAILED,
  )
}

/** Показать файлы открытой ветки с устройства: другая вкладка могла записать правку или разрешить конфликт. */
async function showDevice(): Promise<void> {
  const { branch, phase } = useSession.getState()
  if (phase !== 'ready') return
  const cached = await getCachedFiles(branch).catch(() => null)
  const state = useSession.getState()
  if (!cached?.length || state.branch !== branch || state.phase !== 'ready') return
  useSession.setState({ files: overlay(branch, cached) })
}

function publish() {
  useSession.setState({ queued: queue.size })
}

function publishConflicts() {
  useSession.setState({ conflicts: [...conflictMap.values()].sort((a, b) => a.at.localeCompare(b.at)) })
}

/** «Выйти»: очередь и конфликты стираются вместе с устройством. */
function forgetQueue() {
  queue.clear()
  storedIds.clear()
  goneAt.clear()
  conflictMap.clear()
  problems.clear()
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDelay = RETRY_FIRST
}

/**
 * Когда удалили ветку (по часам этой вкладки): правки ветки, сделанные раньше, больше некуда писать — reconcile
 * не возвращает их в базу, даже если они ещё в памяти какой-то вкладки. Правки новой ветки с тем же именем живут.
 */
const goneAt = new Map<string, string>()

/** Забыть ветку в памяти вкладки. */
function dropBranchMemory(branch: string, at: string): void {
  const prev = goneAt.get(branch)
  if (!prev || prev < at) goneAt.set(branch, at)
  for (const [k, live] of queue) if (live.edit.branch === branch && live.edit.queuedAt <= at) queue.delete(k)
  for (const k of storedIds.keys()) if (k.startsWith(`${branch}\n`) && !queue.has(k)) storedIds.delete(k)
  for (const [k, c] of conflictMap) if (c.branch === branch) conflictMap.delete(k)
  publish()
  publishConflicts()
}

/** Ветку удалили: её кэш, очередь и конфликты больше некуда писать. Другие вкладки узнают об этом по BroadcastChannel. */
async function forgetBranch(branch: string): Promise<void> {
  const at = nowIso()
  dropBranchMemory(branch, at)
  await persist(() =>
    withLock(async () => {
      dropBranchMemory(branch, at) // перечитывание могло вернуть их, пока ждали блокировку
      await dropBranchCache(branch)
      channel?.postMessage({ gone: branch, at })
      return false
    }),
  )
}

/** Файлы удалили из ветки: их правки и конфликты больше не нужны. */
async function forgetFiles(branch: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const k = key(branch, path)
    if (queue.delete(k) || storedIds.has(k)) {
      storedIds.delete(k)
      await persist(() =>
        withLock(async () => {
          queue.delete(k) // перечитывание могло вернуть правку, пока ждали блокировку
          storedIds.delete(k)
          await deleteQueued(branch, path)
        }),
      )
    }
    await updateConflict(branch, path, () => null)
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
    live.patches.push(patch)
    live.rev++
    live.dirty = true
  } else {
    const state = useSession.getState()
    if (state.branch !== branch) throw new ApiError(0, 'network', 'Открыта другая ветка — правка не сохранена')
    const file = state.files.find((f) => f.path === path)
    if (!file) throw new ApiError(404, 'not_found', 'Проекта больше нет в этой ветке')
    const text = render(path, file.sha, file.text, patch)
    queue.set(k, { edit: { branch, path, baseSha: file.sha, baseText: file.text, patch, text, queuedAt: nowIso() }, rev: 0, patches: [patch], saved: 0, dirty: true, epoch: 0 })
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

const snapOf = (live: Live): Snap => ({ rev: live.rev, epoch: live.epoch, n: live.patches.length, id: storedIds.get(key(live.edit.branch, live.edit.path)) })

async function send(live: Live): Promise<SendResult> {
  const { branch, path } = live.edit
  // Что успела сделать с этой правкой другая вкладка, сообщает BroadcastChannel; если она уже отправила правку,
  // повтор получит 409 и слияние увидит, что писать нечего.
  const { remote } = useSession.getState()
  const snap = snapOf(live)
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
  await written(live, snap, sha, sent.text)
  return 'next'
}

/** Правка записана как есть. Если за это время пришли новые правки, они остаются ждать — уже от записанной версии. */
async function written(live: Live, snap: Snap, sha: string, text: string): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  settle(live, snap, { path, sha, text })
  retryDelay = RETRY_FIRST
  await persistEntry(k, snap.id)
  publish()
  await applyWrite(branch, [{ path, sha, text }], [])
}

/**
 * После записи: правки нет — убрать из очереди; пришли новые правки — они ждут от записанной версии, и в правке
 * остаются только они. Иначе уже записанное (в том числе спорные места, отданные репо) легло бы поверх ещё раз.
 */
function settle(live: Live, snap: Snap, saved: CachedFile): void {
  const k = key(live.edit.branch, live.edit.path)
  if (queue.get(k) !== live) return
  if (live.rev === snap.rev) {
    queue.delete(k)
    return
  }
  // Правку целиком заменила запись другой вкладки — какие правки новые, не знаем: берём все.
  const same = live.epoch === snap.epoch
  const later = same ? live.patches.slice(snap.n) : live.patches
  const patch = later.slice(1).reduce((a, p) => mergePatch(a, p), later[0] ?? live.edit.patch)
  live.edit = { ...live.edit, baseSha: saved.sha, baseText: saved.text, patch, text: render(saved.path, saved.sha, saved.text, patch) }
  live.saved = same ? Math.max(0, live.saved - snap.n) : live.saved
  live.patches = later.length ? later : [patch]
  live.dirty = true
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
    const snap = snapOf(live)
    const mine = live.edit
    const fresh = await readFresh(branch, path)
    if (!fresh) return recordDeleted(live)
    if (fresh.sha === mine.baseSha) {
      // Ветку сдвинул коммит в другой файл: наш файл тот же, повторяем запись как есть.
      try {
        const { sha } = await remote.putFile(branch, path, mine.text, mine.baseSha)
        return written(live, snap, sha, mine.text)
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
    // Новые правки, пришедшие за это время, ждут от сохранённой версии: разобранные места не всплывут снова.
    settle(live, snap, saved)
    retryDelay = RETRY_FIRST
    await persistEntry(k, snap.id)
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
  const id = storedIds.get(k)
  if (queue.get(k) === live) queue.delete(k)
  await persistEntry(k, id)
  publish()
  await recordConflict(branch, path, { refused: { reason, mine: live.edit.text } })
  await showCached(branch, path)
}

/** Файл удалили в репо, а у меня правка: выбор — вернуть мою версию или согласиться с удалением. */
async function recordDeleted(live: Live): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  const id = storedIds.get(k)
  if (queue.get(k) === live) queue.delete(k)
  await persistEntry(k, id)
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
  problems.set(key(branch, path), { seq, error: new QueueConflict(problemMessage(problem)) })
  await updateConflict(branch, path, (prev) => withProblem(branch, path, prev, problem))
}

function problemMessage(problem: Problem): string {
  if ('items' in problem)
    return `Эти поля одновременно поменяли в другом месте: ${problem.items.map((it) => conflictLabel(it, problem.local, problem.remote)).join(', ')}. Остальное записано, выбор — во «Входящих конфликтах».`
  if ('refused' in problem) return `Правка не записана: ${problem.refused.reason}. Она сохранена во «Входящих конфликтах».`
  return 'Проект удалили в другом месте. Твоя правка — во «Входящих конфликтах»: можно вернуть проект или согласиться с удалением.'
}

/** Конфликт с новой проблемой поверх прежнего: спорные места, которые ещё не разобраны, остаются; одинаковые — заменяются. */
function withProblem(branch: string, path: string, prev: StoredConflict | undefined, problem: Problem): StoredConflict {
  const slug = path.replace(/^projects\/|\.json$/g, '')
  const rec: StoredConflict = {
    branch,
    path,
    title: prev?.title ?? slug,
    at: nowIso(),
    items: prev?.items ?? [],
    labels: prev?.labels ?? [],
  }
  if ('items' in problem) {
    rec.title = titleOf(problem.remote, problem.local) ?? rec.title
    const byPath = new Map(rec.items.map((it, i) => [it.path.join('\n'), { it, label: rec.labels[i] ?? '' }]))
    for (const it of problem.items) byPath.set(it.path.join('\n'), { it, label: conflictLabel(it, problem.local, problem.remote) })
    rec.items = [...byPath.values()].map((x) => x.it)
    rec.labels = [...byPath.values()].map((x) => x.label)
    if (prev?.refused) rec.refused = prev.refused
    if (prev?.deleted) rec.deleted = prev.deleted
  } else if ('refused' in problem) {
    rec.title = titleOf(problem.refused.mine) ?? rec.title
    rec.refused = problem.refused
  } else {
    rec.title = titleOf(problem.deleted.mine) ?? rec.title
    rec.deleted = problem.deleted
  }
  return rec
}

/**
 * Изменить конфликт файла: прочитать, изменить и записать запись в IndexedDB под блокировкой очереди, в общей
 * цепочке записей. Так перечитывание по сообщению другой вкладки не вклинится между правкой памяти и записью, а две
 * вкладки не затрут спорные места друг друга. fn: undefined — не менять, null — снять конфликт.
 * Если устройство подвело, изменение остаётся в памяти, а индикатор говорит, что на устройстве его нет.
 */
function updateConflict(branch: string, path: string, fn: (prev: StoredConflict | undefined) => StoredConflict | null | undefined): Promise<void> {
  const k = key(branch, path)
  const show = (next: StoredConflict | null) => {
    if (next) conflictMap.set(k, next)
    else conflictMap.delete(k)
    publishConflicts()
  }
  return persist(() =>
    withLock(async () => {
      let stored: StoredConflict | undefined
      try {
        stored = await getConflict(branch, path)
      } catch (e) {
        const next = fn(conflictMap.get(k))
        if (next !== undefined) show(next)
        throw e
      }
      const next = fn(stored)
      if (next === undefined) {
        show(stored ?? null)
        return false
      }
      try {
        if (next) await putConflict(next)
        else if (stored) await deleteConflict(branch, path)
      } finally {
        show(next)
      }
      return true
    }),
  )
}

interface Chosen {
  index: number
  item: MergeConflict
  pick: ConflictPick
}

/**
 * Записать выбор в свежую версию файла. Если файл успели изменить ещё раз — перечитать и повторить.
 * Место, которое в репо изменили снова (там уже не то, что было при слиянии), не пишется: возвращается его новое значение.
 */
async function writeOps(branch: string, path: string, chosen: Chosen[]): Promise<Map<number, Json | undefined>> {
  const { remote } = useSession.getState()
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await readFresh(branch, path)
    if (!fresh) throw new ApiError(404, 'not_found', 'Файла уже нет в репо — выбор некуда записать')
    const doc = parseDoc(fresh.text, 'Файл в репо')
    const stale = new Map<number, Json | undefined>()
    const ops: ConflictOp[] = []
    for (const c of chosen) {
      const own = opsFor(c.item, c.pick)
      if (!own.length) continue
      const now = valueAt(doc, c.item.path)
      if (sameValue(now, heldValue(c.item))) ops.push(...own)
      else stale.set(c.index, now)
    }
    if (!ops.length) return stale
    const changed = applyOps(doc, ops)
    if (typeof doc.updatedAt === 'string') changed.updatedAt = nowIso()
    let next: JsonObject
    try {
      next = finish(path, doc, changed)
    } catch (e) {
      throw new ApiError(422, 'validation', e instanceof Error ? e.message : 'Файл не проходит проверку')
    }
    if (sameContent(next, asWritten(doc))) return stale
    const text = serialize(next)
    try {
      const { sha } = await remote.putFile(branch, path, text, fresh.sha)
      await applyWrite(branch, [{ path, sha, text }], [])
      return stale
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
      throw e
    }
  }
  throw new ApiError(409, 'conflict', 'Файл снова изменился — попробуй ещё раз')
}

/**
 * Спорное место изменили в репо ещё раз: показать новое значение из репо. Элемент, удалённый с обеих сторон, —
 * спорить не о чем (null). Элемент, который я оставил, а в репо снова поменяли, — теперь спор о нём целиком.
 */
function changedAgain(item: MergeConflict, label: string, now: Json | undefined): { item: MergeConflict; label: string } | null {
  if (item.kind === 'field') return { item: { ...item, remote: now }, label }
  if (item.deletedBy === 'local') return now === undefined ? null : { item: { ...item, remote: now }, label }
  const what = label.split(' · ')[0] ?? label
  return { item: { kind: 'field', path: item.path, base: item.base, local: item.local, remote: now }, label: `${what} · ${now === undefined ? 'удалена в репо' : 'изменена в репо'}` }
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
  // Другая вкладка хаба изменила очередь или конфликты — перечитать их с устройства.
  if (typeof BroadcastChannel !== 'undefined') {
    channel?.close()
    channel = new BroadcastChannel(QUEUE_LOCK)
    channel.onmessage = (e: MessageEvent<unknown>) => {
      const d = e.data
      if (d && typeof d === 'object' && typeof (d as { gone?: unknown }).gone === 'string' && typeof (d as { at?: unknown }).at === 'string') {
        const { gone, at } = d as { gone: string; at: string }
        dropBranchMemory(gone, at)
        if (useSession.getState().branch === gone) void useSession.getState().switchBranch(MAIN, `Ветку «${gone}» удалили в другой вкладке — открыта main.`)
      }
      void reloadFromDevice()
    }
  }
  return () => {
    channel?.close()
    channel = null
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
  useSession.setState({ queued: 0, conflicts: [], deviceError: null })
}
