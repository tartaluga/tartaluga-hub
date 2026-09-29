// Сессия и загрузка файлов данных через сервер хаба (ADR-007). Токена в браузере нет:
// вход — HttpOnly cookie, которую ставит сервер. Старт работает офлайн: сначала кэш из IndexedDB, потом сверка.
// Хаб всегда смотрит на одну ветку репо данных; у каждой ветки свой кэш на устройстве.
import { create } from 'zustand'
import { persistDrafts, wipeDrafts } from '../lib/drafts'
import { ApiError, commitChanges, getMe, isNetworkError, listFiles, logout, putFile, readBlobText, type CommitChange, type Me } from '../lib/api'
import {
  deleteConflict,
  deleteQueued,
  dropBranchCache,
  getCachedFiles,
  getConflict,
  getConflicts,
  getCurrentBranch,
  dropQueuedKey,
  getQueue,
  getUnreadableQueued,
  onDbBlocked,
  putCachedFiles,
  putConflict,
  putQueued,
  requestPersistence,
  setCurrentBranch,
  wipeDevice,
  type CachedFile,
  type QueuedEdit,
  type QueueKind,
  type StoredConflict,
} from '../lib/localdb'
import { STALE_BUILD } from '../lib/update'
import { nowIso, parseFile, SCHEMA_VERSIONS, serialize, type WithUnknown } from '../data/model'
import { merge, MergeRefused, type Json, type JsonObject, type MergeConflict } from '../data/merge'
import { applyOps, conflictLabel, heldValue, opsFor, sameContent, sameValue, valueAt, type ConflictOp, type ConflictPick } from '../data/conflicts'
import type { Idea, Project } from '../schema/types'
import { normalizeProject } from '../data/normalize'
import { validateSettings } from '../schema/validators.js'
import { removeTag, type SettingsChange, type SettingsData } from '../components/TagEditor.model'
import { untagProjects } from '../data/projects'
import { applyEdit, mergePatch, type ProjectPatch } from '../data/editProject'
import { applyIdeaPatch, firstLine, mergeIdeaPatch, type IdeaPatch } from '../data/ideas'
import { plural } from '../lib/plural'
import { claimWriter, isReader, isWriter, onBecameWriter, requeueWriter, yieldWriter } from './writer'

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
  /**
   * Хаб открыт в другой вкладке, и пишет она (ADR-013): здесь только просмотр — правки отклоняются с READ_ONLY,
   * очередь не отправляется, на устройство ничего не пишется.
   */
  readOnly: boolean
  /** «Писать здесь» во вкладке просмотра: asking — попросили пишущую уступить, noAnswer — она не ответила. */
  takeover: 'asking' | 'noAnswer' | null
  remote: Remote
  boot(): Promise<void>
  /** Эта вкладка получила лок записи: поднять очередь и конфликты с устройства и начать отправку. */
  becomeWriter(): Promise<void>
  /**
   * «Писать здесь»: попросить пишущую вкладку уступить. Она сохраняет черновики в handoff, отпускает лок и
   * становится просмотром. Нет ответа за timeoutMs (вкладка заморожена) — takeover: noAnswer.
   */
  requestWrite(timeoutMs?: number): void
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
  /** Правка идеи через ту же очередь (ADR-004): как saveProject, путь ideas/<ulid>.json. */
  saveIdea(path: string, patch: IdeaPatch): Promise<void>
  /**
   * Новая идея через очередь: файла в репо ещё нет, запись уйдёт без sha. Сразу видна на экране. Повторяемо:
   * та же идея уже в очереди или уже в ветке с тем же содержимым — ничего не делает; другая с этим путём — ошибка.
   */
  addIdea(path: string, text: string): Promise<void>
  /** Новая идея ещё в очереди (в репо её нет) — убрать с устройства и с экрана. true — убрали. */
  discardNew(path: string): Promise<boolean>
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

/**
 * Единая точка входа правок (ADR-013): во вкладке просмотра любое действие, которое пишет, отклоняется с READ_ONLY
 * до того, как что-то попадёт в очередь, на сервер или в IndexedDB.
 */
function onlyWriter<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => {
    try {
      assertWriter()
    } catch (e) {
      return Promise.reject(e)
    }
    return fn(...args)
  }
}

/** Проверка входа для правок вне сессии (ветки, «Сделать проектом»): во вкладке просмотра — ошибка READ_ONLY. */
export function assertWriter(): void {
  if (useSession.getState().readOnly || yielding) throw new ApiError(423, 'read_only', READ_ONLY)
}

/**
 * Защита в глубине (ADR-013): писать на устройство и на сервер можно, только если лок записи у этой вкладки
 * (или о локе ещё не спрашивали) и после «Выйти» сессию не начинали заново. Иначе запись отбрасывается.
 */
function canWrite(): boolean {
  return !wiped && !isReader()
}

/** Запись на сервер — только через этот вход: во вкладке просмотра и после выхода — отказ. */
export function writeRemote(): Pick<Remote, 'putFile' | 'commit'> {
  const refuse = () => Promise.reject(new ApiError(423, 'read_only', wiped ? 'Ты вышел из хаба — правка не отправлена' : READ_ONLY))
  const remote = useSession.getState().remote
  return {
    putFile: (...args) => (canWrite() ? remote.putFile(...args) : refuse()),
    commit: (...args) => (canWrite() ? remote.commit(...args) : refuse()),
  }
}

/** Сессия стёрта «Выйти»: ответы уже отправленных запросов на устройство не пишутся. Снимает boot. */
let wiped = false
/** Пишущая вкладка уступает запись: новые правки не принимаются, текущая отправка дописывается. */
let yielding = false
/** Идущий boot: becomeWriter ждёт его, чтобы не работать с веткой и данными до старта. */
let booting: Promise<void> = Promise.resolve()
let takeoverTimer: ReturnType<typeof setTimeout> | null = null

/** Сколько ждать ответа пишущей вкладки на «Писать здесь». */
export const TAKEOVER_TIMEOUT_MS = 5_000

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
  readOnly: false,
  takeover: null,
  remote: serverRemote,

  boot() {
    const run = booting.catch(() => undefined).then(async () => {
      wiped = false
      await claimWriter()
      const readOnly = !isWriter()
      set({ readOnly })
      const branch = await getCurrentBranch().catch(() => MAIN)
      await (readOnly ? loadReadOnly() : reloadFromDevice())
      const files = overlay(branch, await getCachedFiles(branch).catch(() => []))
      set({ branch })
      try {
        const me = await get().remote.me()
        set({ phase: 'ready', me, files })
        void requestPersistence()
        void get().syncNow()
      } catch (e) {
        // Экран входа — только если сервер сказал «не вошёл» (401) или показать нечего. Любой другой сбой
        // (нет сети, 5xx, 429, ответ не JSON) при данных на устройстве — работаем с ними; вход, сверка и
        // отправка очереди — при следующем триггере (онлайн, возврат на вкладку, кнопка индикатора).
        const unauthorized = e instanceof ApiError && e.status === 401
        if (unauthorized || !files.length) set({ phase: 'signedOut', files })
        else set({ phase: 'ready', files, sync: isNetworkError(e) ? 'offline' : 'error', syncError: errorText(e) })
      }
    })
    booting = run
    return run
  },

  async becomeWriter() {
    await booting.catch(() => undefined) // ветка и данные просмотра уже на месте
    if (!get().readOnly) return
    // Пока очередь поднимается с устройства, вкладка ещё просмотр: правки не принимаются.
    // Открытая здесь ветка становится открытой веткой устройства: её и продолжаем.
    if (canWrite()) await setCurrentBranch(get().branch).catch(() => undefined)
    await reloadFromDevice()
    if (takeoverTimer) clearTimeout(takeoverTimer)
    takeoverTimer = null
    set({ readOnly: false, takeover: null })
    if (get().phase === 'ready') await get().syncNow()
  },

  requestWrite(timeoutMs = TAKEOVER_TIMEOUT_MS) {
    if (!get().readOnly) return
    set({ takeover: 'asking' })
    tell('takeover')
    if (takeoverTimer) clearTimeout(takeoverTimer)
    takeoverTimer = setTimeout(() => {
      takeoverTimer = null
      if (get().readOnly && get().takeover === 'asking') set({ takeover: 'noAnswer' })
    }, timeoutMs)
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
    await wipeLocal()
    tell('signedOut') // другие вкладки хаба стирают своё и показывают вход
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
    if (get().readOnly) return Promise.resolve() // отправляет пишущая вкладка
    running ??= drain()
    return running
  },

  async syncNow() {
    await get().refresh()
    await get().flush()
  },

  async switchBranch(name, notice) {
    if (name === get().branch) return
    if (canWrite()) await setCurrentBranch(name).catch(() => undefined)
    const files = overlay(name, await getCachedFiles(name).catch(() => []))
    set({ branch: name, files, tree: null, branchNotice: notice ?? null, sync: 'idle', syncError: null, lastSync: null })
    await get().refresh()
  },

  settleBranch: onlyWriter(async (name) => {
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
  }),

  branchDeleted: onlyWriter(async (name) => {
    await forgetBranch(name)
    if (get().branch === name) await get().switchBranch(MAIN)
  }),

  dismissBranchNotice() {
    set({ branchNotice: null })
  },

  createFile: onlyWriter(async (path, text) => {
    const { branch } = get()
    const { sha } = await writeRemote().putFile(branch, path, text)
    await applyWrite(branch, [{ path, sha, text }], [])
    void get().refresh()
  }),

  deleteFiles: onlyWriter(async (pathsOf, message, also) => {
    const { branch } = get()
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
        const res = await writeRemote().commit(branch, changes, tree.head, part === 1 ? message : `${message} (часть ${part})`)
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
  }),

  saveProject: onlyWriter((slug, patch) => {
    return submit(get().branch, `projects/${slug}.json`, 'project', patch)
  }),

  saveIdea: onlyWriter((path, patch) => {
    return submit(get().branch, path, 'idea', patch)
  }),

  addIdea: onlyWriter(async (path, text) => {
    const branch = get().branch
    if (queue.has(key(branch, path))) return // тот же черновик уже ждёт отправки
    const file = get().files.find((f) => f.path === path)
    if (file) {
      // Прошлая попытка дошла (правило 6 schema/README.md): та же идея — успех, другая — не затираем.
      if (file.text === text) return
      throw new ApiError(409, 'conflict', 'Идея с таким номером уже есть в репо, и она другая — не сохранено')
    }
    await submit(branch, path, 'idea', {}, text)
  }),

  discardNew: onlyWriter(async (path) => {
    const branch = get().branch
    const k = key(branch, path)
    // Запись уже летит на сервер — дождаться ответа: дошла — файл в репо, и его удалит обычное удаление.
    while (sendingKey === k) await sendingDone
    const live = queue.get(k)
    if (!live || live.edit.baseSha) return false
    queue.delete(k)
    await persistEntry(k)
    publish()
    await updateConflict(branch, path, () => null)
    await showCached(branch, path)
    return true
  }),

  resolveConflict: onlyWriter(async (branch, path, picks) => {
    const k = key(branch, path)
    const rec = conflictMap.get(k)
    if (!rec) return
    if (rec.deleted || rec.refused) {
      // Файл удалили в репо: «моя» — вернуть его с моей правкой, «из репо» — согласиться с удалением.
      // Мою версию, которую не удалось слить или записать, записать нельзя — можно только отказаться от неё.
      const restore = !!rec.deleted && picks.some((p) => p.pick === 'mine')
      if (restore) {
        const { sha } = await writeRemote().putFile(branch, path, rec.deleted!.mine)
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
    // Разобранное снимается со свежей записи на устройстве: пока шла запись, отправка могла дописать в неё спорные места.
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
  }),

  saveSettings: onlyWriter((change) => {
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
  }),

  deleteTag: onlyWriter((id) => {
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
  }),
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
      const res = await writeRemote().commit(branch, changes, tree.head, `Хаб: удалить тег ${id}`)
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
  const remote = writeRemote()
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
  if (!canWrite()) return // вкладка просмотра или уже вышли: ни на устройство, ни на экран
  await putCachedFiles(branch, changed, removed).then(() => tell('changed'), () => undefined)
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

    // Кэш на устройстве пишет только пишущая вкладка (ADR-013); вкладка просмотра держит свежее только на экране.
    if ((changed.length || removed.length) && canWrite()) {
      await putCachedFiles(branch, changed, removed)
      tell('changed')
    }
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
      if (canWrite()) await forgetBranch(branch)
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

type Patch = ProjectPatch | IdeaPatch

/** Вид файла записи очереди: записи без kind (до STATE_VERSION 2) — правки проекта. */
const kindOf = (edit: QueuedEdit): QueueKind => edit.kind ?? 'project'

interface Live {
  edit: QueuedEdit
  /** Растёт с каждой правкой, влитой в ожидающую: так видно, что во время отправки пришло новое. */
  rev: number
  /** Правки с базовой копии по порядку (edit.patch — их слияние): после записи остаются только пришедшие позже. */
  patches: Patch[]
  /** В памяти есть то, чего ещё нет в IndexedDB. */
  dirty: boolean
}

/** Снимок правки перед отправкой: по нему после записи видно, что пришло за это время. */
interface Snap {
  rev: number
  /** Сколько правок было в patches. */
  n: number
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

// Пишет одна вкладка (ADR-013, writer.ts). Остальные вкладки только смотрят: пишущая сообщает им по
// BroadcastChannel «перечитай устройство», а выход из любой вкладки — «вышли, сотри своё».
const CHANNEL = 'hub-data'
type Message = 'changed' | 'signedOut' | 'takeover'
let channel: BroadcastChannel | null = null

function tell(msg: Message): void {
  channel?.postMessage(msg)
}

export const DEVICE_WRITE_FAILED = 'Правка не сохранилась на устройстве — не закрывай хаб, пока она не отправится.'
export const DEVICE_READ_FAILED = 'Не удалось прочитать очередь правок с устройства — перезапусти хаб; то, что на экране, не потеряно.'
export const NOTHING_WRITTEN = 'Пока ты выбирал, это место в репо изменили ещё раз. Ничего не записано: на экране новое значение — выбери снова.'
export const PARTLY_WRITTEN = 'Часть выбора записана. Остальные места в репо изменили ещё раз, пока ты выбирал: на экране новое значение — выбери снова.'
export const DB_BLOCKED = 'Хаб обновляется: закрой другие вкладки хаба, чтобы продолжить.'
export const READ_ONLY = 'Хаб открыт в другой вкладке — правь там. Здесь только просмотр.'

onDbBlocked((blocked) => {
  if (blocked) useSession.setState({ deviceError: DB_BLOCKED })
  else if (useSession.getState().deviceError === DB_BLOCKED) useSession.setState({ deviceError: null })
})

// Вкладка стала пишущей, когда прежняя закрылась: подхватить очередь, конфликты и отправку.
onBecameWriter(() => void useSession.getState().becomeWriter())

/**
 * Записи в базу идут одной цепочкой, чтобы порядок сохранения совпадал с порядком правок. Ошибку записи не глотаем
 * молча: правка остаётся в памяти и уходит на сервер, а индикатор говорит, что на устройстве её нет.
 * op возвращает false, если ничего не записал, — тогда вкладкам просмотра сообщать не о чем.
 */
function persist(op: () => Promise<void | boolean>, failText = DEVICE_WRITE_FAILED): Promise<void> {
  // Проверка в момент записи, а не постановки: вышли или уступили запись, пока запись ждала очереди, — не пишем.
  dbChain = dbChain.then(() => (canWrite() ? op() : false)).then(
    (wrote) => {
      if (wrote !== false) tell('changed')
      const { deviceError } = useSession.getState()
      if (deviceError === failText && (failText === DEVICE_READ_FAILED || ![...queue.values()].some((l) => l.dirty))) useSession.setState({ deviceError: null })
    },
    () => useSession.setState({ deviceError: failText }),
  )
  return dbChain
}

/** Привести запись файла в IndexedDB к памяти: правка есть — записать её текущую версию, нет — удалить запись. */
function persistEntry(k: string): Promise<void> {
  return persist(async () => {
    const [branch = '', path = ''] = k.split('\n')
    const live = queue.get(k)
    if (!live) {
      await deleteQueued(branch, path)
      return
    }
    const { rev } = live
    await putQueued(live.edit)
    if (queue.get(k) === live && live.rev === rev) live.dirty = false
  })
}

/** Правка файла из записи на устройстве. */
const liveOf = (edit: QueuedEdit): Live => ({ edit, rev: 0, patches: [edit.patch], dirty: false })

/**
 * Пишущая вкладка поднимает очередь и конфликты с устройства: старт и момент, когда она стала пишущей.
 * Записи, которые эта сборка не понимает, уходят во «Входящие». Правки, которых ещё нет в базе, не теряются.
 */
function reloadFromDevice(): Promise<void> {
  return persist(async () => {
    // Записи, которые эта сборка не понимает (ADR-011 §6): во «Входящие» как отказ с моей версией, из очереди — вон.
    // Сперва конфликт, потом удаление: упадёт между ними — запись останется в очереди и уйдёт в следующий раз.
    const unreadable = await getUnreadableQueued()
    for (const { key: raw, item } of unreadable) {
      const next = withProblem(item.branch, item.path, await getConflict(item.branch, item.path), { refused: { reason: `запись очереди не разобрана (${item.reason})`, mine: item.mine } })
      await putConflict(next)
      await dropQueuedKey(raw)
    }
    await readDevice()
    return unreadable.length > 0
  }, DEVICE_READ_FAILED)
}

/** Вкладка просмотра перечитывает устройство: ничего не пишет, только показывает то, что записала пишущая. */
function loadReadOnly(): Promise<void> {
  return readDevice().then(
    () => {
      if (useSession.getState().deviceError === DEVICE_READ_FAILED) useSession.setState({ deviceError: null })
    },
    () => useSession.setState({ deviceError: DEVICE_READ_FAILED }),
  )
}

/** Очередь и конфликты с устройства — в память и на экран. Правки в памяти, ещё не записанные в базу, остаются. */
async function readDevice(): Promise<void> {
  const [records, conflicts] = await Promise.all([getQueue(), getConflicts()])
  const onDevice = new Map(records.map((r) => [key(r.branch, r.path), r]))
  for (const [k, live] of queue) if (!live.dirty && !onDevice.has(k)) queue.delete(k)
  for (const [k, r] of onDevice) if (!queue.get(k)?.dirty) queue.set(k, liveOf(r))
  conflictMap.clear()
  for (const c of conflicts) conflictMap.set(key(c.branch, c.path), c)
  publish()
  publishConflicts()
  void showDevice()
}

/** Показать файлы открытой ветки с устройства (с правками из очереди поверх). */
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

/**
 * Всё неотправленное на устройстве, по всем веткам: ожидающие правки (из памяти — там есть и то,
 * что не успело лечь в IndexedDB) и входящие конфликты. Для «Скачать неотправленное» (ADR-004).
 */
export function unsentSnapshot(): { edits: QueuedEdit[]; conflicts: StoredConflict[] } {
  return { edits: [...queue.values()].map((l) => l.edit), conflicts: [...conflictMap.values()] }
}

function publishConflicts() {
  useSession.setState({ conflicts: [...conflictMap.values()].sort((a, b) => a.at.localeCompare(b.at)) })
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

/** Стереть с устройства всё своё: память очереди, IndexedDB, черновики — и показать экран входа. */
async function wipeLocal(): Promise<void> {
  wiped = true
  forgetQueue()
  await wipeDevice().catch(() => undefined)
  await wipeDrafts().catch(() => undefined) // черновики для обновления хаба (ADR-011)
  useSession.setState({ phase: 'signedOut', me: null, branch: MAIN, branchNotice: null, files: [], tree: null, sync: 'idle', syncError: null, lastSync: null, queued: 0, conflicts: [], deviceError: null })
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
    if (queue.delete(k)) await persistEntry(k)
    await updateConflict(branch, path, () => null)
  }
  publish()
  publishConflicts()
}

/** Файлы ветки для экрана: у файлов с ожидающей правкой — моя версия; новые файлы из очереди (в репо их ещё нет) — тоже. */
function overlay(branch: string, files: CachedFile[]): CachedFile[] {
  if (!queue.size) return files
  const out = files.map((f) => {
    const live = queue.get(key(branch, f.path))
    return live ? { ...f, text: live.edit.text } : f
  })
  const have = new Set(files.map((f) => f.path))
  for (const { edit } of queue.values()) {
    if (edit.branch === branch && !edit.baseSha && !have.has(edit.path)) out.push({ path: edit.path, sha: '', text: edit.text })
  }
  return out
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

/** Слить две правки одного файла по его виду. */
function mergeAny(kind: QueueKind, a: Patch, b: Patch): Patch {
  return kind === 'idea' ? mergeIdeaPatch(a as IdeaPatch, b as IdeaPatch) : mergePatch(a as ProjectPatch, b as ProjectPatch)
}

/**
 * Моя версия файла: базовая копия с правкой. Проект нормализуется (ADR-009), идея — нет (applyIdeaPatch + схема).
 * Пустой baseSha у идеи — создание: baseText — новый файл, правка ложится на него.
 */
function render(kind: QueueKind, path: string, baseSha: string, baseText: string, patch: Patch): string {
  const parsed = parseFile(path, baseSha, baseText)
  if (!parsed.ok) throw new ApiError(422, 'validation', `Файл не читается: ${parsed.error}`)
  if (parsed.readOnly) throw new ApiError(422, 'validation', parsed.reason)
  if (parsed.kind !== kind) throw new ApiError(422, 'validation', `${path}: не тот вид файла для правки`)
  if (kind === 'idea') {
    const r = applyIdeaPatch(parsed.data as WithUnknown<Idea>, patch as IdeaPatch)
    if (!r.ok) throw new ApiError(422, 'validation', r.error)
    return r.changed ? serialize(r.data) : baseText
  }
  const prev = parsed.data as WithUnknown<Project>
  return serialize(normalizeProject(prev, applyEdit(prev, patch as ProjectPatch) as WithUnknown<Project>))
}

/**
 * Положить правку в очередь: новая правка файла сливается с ожидающей, база остаётся прежней. Возвращает номер правки.
 * created — текст нового файла (создание идеи): база — «файла нет».
 */
function enqueue(branch: string, path: string, kind: QueueKind, patch: Patch, created?: string): number {
  const k = key(branch, path)
  const live = queue.get(k)
  if (live) {
    const merged = mergeAny(kind, live.edit.patch, patch)
    live.edit = { ...live.edit, patch: merged, text: render(kind, path, live.edit.baseSha, live.edit.baseText, merged) }
    live.patches.push(patch)
    live.rev++
    live.dirty = true
  } else {
    const state = useSession.getState()
    if (state.branch !== branch) throw new ApiError(0, 'network', 'Открыта другая ветка — правка не сохранена')
    const file = created === undefined ? state.files.find((f) => f.path === path) : { sha: '', text: created }
    if (!file) throw new ApiError(404, 'not_found', kind === 'idea' ? 'Идеи больше нет в этой ветке' : 'Проекта больше нет в этой ветке')
    const text = render(kind, path, file.sha, file.text, patch)
    queue.set(k, { edit: { kind, branch, path, baseSha: file.sha, baseText: file.text, patch, text, queuedAt: nowIso() }, rev: 0, patches: [patch], dirty: true })
  }
  showEdit(branch)
  publish()
  return ++seq
}

/**
 * Правка через очередь (ADR-004): сразу на экране и в IndexedDB, потом отправка. Промис завершается, когда правка
 * записана или отложена (нет сети, нужен вход); если часть правки ушла во «Входящие конфликты» — QueueConflict.
 */
async function submit(branch: string, path: string, kind: QueueKind, patch: Patch, created?: string): Promise<void> {
  const k = key(branch, path)
  const mine = enqueue(branch, path, kind, patch, created)
  await persistEntry(k)
  if (!persistAsked) {
    persistAsked = true
    void requestPersistence() // ADR-004: чтобы браузер не вычистил очередь при нехватке места; результат не важен
  }
  await useSession.getState().flush()
  const problem = problems.get(k)
  if (problem && problem.seq >= mine) throw problem.error
}

/** Есть ли у файла ветки неотправленная правка. */
export function hasQueued(branch: string, path: string): boolean {
  return queue.has(key(branch, path))
}

/** Разбор цикла отправки: по одному файлу, по порядку правок. */
async function drain(): Promise<void> {
  await null // running должен быть присвоен до того, как цикл сможет закончиться
  try {
    for (;;) {
      const state = useSession.getState()
      if (state.phase !== 'ready' || state.sync === 'sessionExpired' || yielding || !canWrite()) return
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

const snapOf = (live: Live): Snap => ({ rev: live.rev, n: live.patches.length })

/** Какой файл эта вкладка сейчас отправляет и когда закончит: discardNew ждёт, чтобы не разойтись с сервером. */
let sendingKey: string | null = null
let sendingDone: Promise<unknown> = Promise.resolve()

async function send(live: Live): Promise<SendResult> {
  const k = key(live.edit.branch, live.edit.path)
  const p = sendOne(live)
  sendingKey = k
  sendingDone = p.catch(() => undefined)
  try {
    return await p
  } finally {
    if (sendingKey === k) sendingKey = null
  }
}

async function sendOne(live: Live): Promise<SendResult> {
  const { branch, path } = live.edit
  // Если прошлая попытка дошла, а ответ потерялся, повтор получит 409 и слияние увидит, что писать нечего.
  const snap = snapOf(live)
  const sent = live.edit
  let sha: string
  // Правка вернула файл к базе (например, текст поменяли и вернули): писать нечего.
  if (sent.baseSha && sent.text === sent.baseText) {
    await written(live, snap, sent.baseSha, sent.text)
    return 'next'
  }
  try {
    // Пустой baseSha — создание: без sha, повторяемо (сервер: тот же файл — успех, другой — 409).
    sha = (await writeRemote().putFile(branch, path, sent.text, sent.baseSha || undefined)).sha
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
  await persistEntry(k)
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
  const later = live.patches.slice(snap.n)
  const kind = kindOf(live.edit)
  const patch = later.slice(1).reduce((a, p) => mergeAny(kind, a, p), later[0] ?? live.edit.patch)
  live.edit = { ...live.edit, baseSha: saved.sha, baseText: saved.text, patch, text: render(kind, saved.path, saved.sha, saved.text, patch) }
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

/** Файл идеи (ideas/<ulid>.json), а не проекта. */
export const isIdeaPath = (path: string) => path.startsWith('ideas/')

/** Тот же созданный файл: совпадают id и момент создания (идея — ULID и createdAt из черновика). */
const sameOrigin = (a: JsonObject, b: JsonObject) => typeof a.id === 'string' && a.id === b.id && typeof a.createdAt === 'string' && a.createdAt === b.createdAt

/** Нормализовать слитый файл (только проект, ADR-009) и проверить его схемой до отправки. */
function finish(path: string, prev: JsonObject, next: JsonObject): JsonObject {
  const out = isIdeaPath(path) ? next : (normalizeProject(prev as WithUnknown<Project>, next as WithUnknown<Project>) as JsonObject)
  const parsed = parseFile(path, '', serialize(out))
  if (!parsed.ok) throw new MergeRefused(`после слияния файл не проходит проверку: ${parsed.error}`)
  return out
}

/** Файл из репо так, как хаб записал бы его без правок: проект — нормализованный (ADR-009), идея — как есть. */
const asWritten = (path: string, doc: JsonObject) =>
  isIdeaPath(path) ? doc : (normalizeProject(doc as WithUnknown<Project>, doc as WithUnknown<Project>) as JsonObject)

/**
 * Конфликт версий (ADR-004): перечитать файл; тот же sha — ложный конфликт, повтор без слияния; иначе трёхстороннее
 * слияние сырых файлов (ADR-010). Слившееся записывается, спорные места — во «Входящие конфликты».
 */
async function mergeAndSend(live: Live): Promise<void> {
  const { branch, path } = live.edit
  const k = key(branch, path)
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = snapOf(live)
    const mine = live.edit
    const fresh = await readFresh(branch, path)
    if (!mine.baseSha) {
      // Создание (правило 6 schema/README.md): файла нет — повторяем; тот же файл уже есть — прошлая попытка дошла.
      if (!fresh) {
        try {
          const { sha } = await writeRemote().putFile(branch, path, mine.text)
          return written(live, snap, sha, mine.text)
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
          throw e
        }
      }
      // Файл уже есть. Если это моя идея (тот же id и момент создания) — прошлая попытка дошла, а потом её могли
      // править (на другом устройстве): обычное трёхстороннее слияние от созданного файла.
      // Другая идея с тем же именем — не затираем, моя версия уходит во «Входящие».
      if (!sameOrigin(parseDoc(mine.baseText, 'Моя версия'), parseDoc(fresh.text, 'Файл в репо'))) {
        throw new MergeRefused('в репо уже есть другой файл с этим именем — моя версия не записана, чтобы его не затереть')
      }
    }
    if (!fresh) return recordDeleted(live)
    if (fresh.sha === mine.baseSha) {
      // Ветку сдвинул коммит в другой файл: наш файл тот же, повторяем запись как есть.
      try {
        const { sha } = await writeRemote().putFile(branch, path, mine.text, mine.baseSha)
        return written(live, snap, sha, mine.text)
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
        throw e
      }
    }
    const theirs = parseDoc(fresh.text, 'Файл в репо')
    const local = parseDoc(mine.text, 'Моя версия')
    const { merged, conflicts } = merge(kindOf(mine), parseDoc(mine.baseText, 'Базовая копия'), local, theirs)
    const next = finish(path, theirs, merged)
    let saved: CachedFile = fresh
    // Моя правка уже в репо (ответ прошлой записи потерялся) — писать нечего, кроме времени и нормализации.
    if (!sameContent(next, asWritten(path, theirs))) {
      const text = serialize(next)
      try {
        saved = { path, sha: (await writeRemote().putFile(branch, path, text, fresh.sha)).sha, text }
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code !== STALE_BUILD) continue
        throw e
      }
    }
    if (conflicts.length) await recordConflict(branch, path, { items: conflicts, local, remote: theirs })
    // Новые правки, пришедшие за это время, ждут от сохранённой версии: разобранные места не всплывут снова.
    settle(live, snap, saved)
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
    // У идеи названия нет: заголовок — первая строка текста.
    const text = doc && typeof doc === 'object' ? (doc as { text?: unknown }).text : undefined
    if (typeof text === 'string' && firstLine(text)) return firstLine(text)
  }
  return undefined
}

/** Записать конфликт файла. Спорные места того же файла, которые ещё не разобраны, остаются; одинаковые — заменяются. */
async function recordConflict(branch: string, path: string, problem: Problem): Promise<void> {
  problems.set(key(branch, path), { seq, error: new QueueConflict(problemMessage(path, problem)) })
  await updateConflict(branch, path, (prev) => withProblem(branch, path, prev, problem))
}

function problemMessage(path: string, problem: Problem): string {
  if ('items' in problem)
    return `Эти поля одновременно поменяли в другом месте: ${problem.items.map((it) => conflictLabel(it, problem.local, problem.remote)).join(', ')}. Остальное записано, выбор — во «Входящих конфликтах».`
  if ('refused' in problem) return `Правка не записана: ${problem.refused.reason}. Она сохранена во «Входящих конфликтах».`
  if (isIdeaPath(path)) return 'Идею удалили в другом месте. Твоя правка — во «Входящих конфликтах»: можно вернуть идею или согласиться с удалением.'
  return 'Проект удалили в другом месте. Твоя правка — во «Входящих конфликтах»: можно вернуть проект или согласиться с удалением.'
}

/** Конфликт с новой проблемой поверх прежнего: спорные места, которые ещё не разобраны, остаются; одинаковые — заменяются. */
function withProblem(branch: string, path: string, prev: StoredConflict | undefined, problem: Problem): StoredConflict {
  const slug = path.replace(/^(projects|ideas)\/|\.json$/g, '')
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
    // Новый отказ не затирает прежние мои версии файла: они уходят в earlier (старые первыми).
    const earlier = withoutRepeats([...(prev?.refused?.earlier ?? []), prev?.refused?.mine, prev?.deleted?.mine], problem.refused.mine)
    rec.refused = earlier.length ? { reason: problem.refused.reason, mine: problem.refused.mine, earlier } : { reason: problem.refused.reason, mine: problem.refused.mine }
  } else {
    rec.title = titleOf(problem.deleted.mine) ?? rec.title
    rec.deleted = problem.deleted
    if (prev?.refused) rec.refused = prev.refused
    // Прежняя моя версия удалённого файла не теряется: уходит в earlier (экран показывает его вместе с refused).
    const old = prev?.deleted?.mine
    if (old !== undefined && old !== problem.deleted.mine) {
      if (prev?.refused) {
        const earlier = withoutRepeats([...(prev.refused.earlier ?? []), old], problem.deleted.mine).filter((t) => t !== prev.refused!.mine)
        rec.refused = { ...prev.refused, earlier }
      } else {
        rec.refused = { reason: 'Файл удалили в репо, прежняя правка не записана', mine: old }
      }
    }
  }
  return rec
}

/** Прежние версии без пустых, повторов и совпадающих с текущей. */
function withoutRepeats(texts: (string | undefined)[], current: string): string[] {
  const out: string[] = []
  for (const t of texts) if (t !== undefined && t !== current && !out.includes(t)) out.push(t)
  return out
}

/**
 * Изменить конфликт файла: прочитать, изменить и записать запись в IndexedDB в общей цепочке записей, чтобы
 * порядок записей совпадал с порядком правок. fn: undefined — не менять, null — снять конфликт.
 * Если устройство подвело, изменение остаётся в памяти, а индикатор говорит, что на устройстве его нет.
 */
function updateConflict(branch: string, path: string, fn: (prev: StoredConflict | undefined) => StoredConflict | null | undefined): Promise<void> {
  const k = key(branch, path)
  const show = (next: StoredConflict | null) => {
    if (next) conflictMap.set(k, next)
    else conflictMap.delete(k)
    publishConflicts()
  }
  return persist(async () => {
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
  })
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
    if (sameContent(next, asWritten(path, doc))) return stale
    const text = serialize(next)
    try {
      const { sha } = await writeRemote().putFile(branch, path, text, fresh.sha)
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
  // Сообщения других вкладок хаба (ADR-013): пишущая изменила данные — перечитать; вышли в любой вкладке — стереть своё.
  if (typeof BroadcastChannel !== 'undefined') {
    channel?.close()
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (e: MessageEvent<unknown>) => void onMessage(e.data)
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

/** Сообщение другой вкладки. Чужие и незнакомые сообщения игнорируются. */
async function onMessage(msg: unknown): Promise<void> {
  const state = useSession.getState()
  if (msg === 'signedOut') {
    if (state.phase !== 'signedOut') await wipeLocal()
    return
  }
  if (msg === 'takeover') {
    // Пишущая уступает; другие вкладки просмотра пропускают просящую вперёд в очереди за локом.
    if (isWriter()) await yieldWrite()
    else requeueWriter()
    return
  }
  // «Перечитай» слушает только вкладка просмотра: пишущая одна, и данные на устройстве — её.
  if (msg === 'changed' && state.readOnly) await loadReadOnly()
}

/**
 * Уступить запись другой вкладке («Писать здесь»): не принимать новые правки, дождаться текущей отправки,
 * записей на устройство и настроек, сохранить черновики в handoff — и только потом отпустить лок.
 */
async function yieldWrite(): Promise<void> {
  if (yielding) return
  yielding = true
  try {
    await running?.catch(() => undefined)
    await Promise.all([...saving.values()].map((p) => p.catch(() => undefined)))
    await dbChain
    await persistDrafts().catch(() => undefined)
    useSession.setState({ readOnly: true })
    yieldWriter()
  } finally {
    yielding = false
  }
  await loadReadOnly()
}

/** Только для тестов: забыть очередь в памяти, как при перезапуске приложения. */
export function resetQueueMemory(): void {
  forgetQueue()
  persistAsked = false
  running = null
  seq = 0
  wiped = false
  yielding = false
  booting = Promise.resolve()
  if (takeoverTimer) clearTimeout(takeoverTimer)
  takeoverTimer = null
  useSession.setState({ queued: 0, conflicts: [], deviceError: null, readOnly: false, takeover: null })
}
