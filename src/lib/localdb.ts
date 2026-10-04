// Локальное хранилище устройства (IndexedDB): кэш файлов по веткам, очередь правок и входящие конфликты (ADR-004).
// Токенов здесь нет (ADR-007). Кэш и очередь раздельны по веткам (ADR-007): правка на ветке-эксперименте уходит только в неё.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ProjectPatch } from '../data/editProject'
import type { IdeaPatch } from '../data/ideas'
import type { MergeConflict } from '../data/merge'

export interface CachedFile {
  path: string
  /** sha blob-а в git — по нему понимаем, изменился ли файл. */
  sha: string
  text: string
}

interface StoredFile extends CachedFile {
  branch: string
}

/** Какой файл правит запись очереди: проект (projects/<slug>.json) или идея (ideas/<ulid>.json). */
export type QueueKind = 'project' | 'idea'

/**
 * Ожидающая правка файла (ADR-004): одна на [ветка, путь]. Новая правка того же файла сливается с ней,
 * базовая копия (версия, от которой считается правка) остаётся прежней.
 */
export interface QueuedEdit {
  /** Вид файла. Записи до STATE_VERSION 2 поля не имеют — это правка проекта (readQueued дописывает kind при чтении). */
  kind?: QueueKind
  branch: string
  path: string
  /**
   * sha и текст базовой копии. Пустой baseSha — файла в репо ещё нет (создание идеи): baseText — новый файл,
   * от него считается правка, а запись уходит без sha и повторяема по правилу 6 schema/README.md.
   */
  baseSha: string
  baseText: string
  /** Все правки, накопленные с базовой копии: ProjectPatch у проекта, IdeaPatch у идеи. */
  patch: ProjectPatch | IdeaPatch
  /** Моя версия файла: базовая копия с правкой. Её видно на экране до отправки. */
  text: string
  queuedAt: string
  /**
   * Версия записи из сборок, где очередь писали несколько вкладок. Больше не пишется (ADR-013), но в старых
   * записях может быть — читается и сохраняется как есть.
   */
  id?: string
}

/** Входящий конфликт файла (ADR-004, ADR-010): одна запись на [ветка, путь], в ней все спорные места. */
export interface StoredConflict {
  branch: string
  path: string
  /** Название проекта для экрана. */
  title: string
  at: string
  /** Спорные поля и элементы. В файле в репо на их местах — версия из репо. */
  items: MergeConflict[]
  /** Подпись каждого спорного места для экрана («задача «…» · срок»), по индексу items. */
  labels: string[]
  /**
   * Правку не удалось ни слить, ни записать: причина и моя версия файла целиком.
   * earlier — мои прежние отклонённые версии того же файла (старые первыми), если отказов было несколько:
   * новый отказ не затирает прежний. Поле необязательное — старые записи читаются как есть.
   */
  refused?: { reason: string; mine: string; earlier?: string[] }
  /** Файл удалили в репо, а у меня была правка: моя версия файла. */
  deleted?: { mine: string }
}

/** Обложка на устройстве. Ключ — sha blob-а: содержимое под одним sha не меняется, поэтому запись не устаревает. */
export interface CachedCover {
  sha: string
  type: 'image/webp' | 'image/jpeg'
  bytes: Blob
}

interface HubDB extends DBSchema {
  covers: { key: string; value: CachedCover }
  kv: { key: string; value: unknown }
  branchFiles: { key: [string, string]; value: StoredFile; indexes: { branch: string } }
  queue: { key: [string, string]; value: QueuedEdit; indexes: { branch: string } }
  conflicts: { key: [string, string]; value: StoredConflict; indexes: { branch: string } }
}

const DB_NAME = 'tartaluga-hub'
const BRANCH_KEY = 'branch'
let dbPromise: Promise<IDBPDatabase<HubDB>> | null = null
const blockedListeners = new Set<(blocked: boolean) => void>()

/**
 * Подписка на «обновление базы ждёт другие вкладки»: true — другая вкладка держит старую версию базы открытой,
 * false — дождались, база открылась. Возвращает отписку.
 */
export function onDbBlocked(fn: (blocked: boolean) => void): () => void {
  blockedListeners.add(fn)
  return () => blockedListeners.delete(fn)
}

const tellBlocked = (blocked: boolean) => blockedListeners.forEach((fn) => fn(blocked))

function db() {
  if (dbPromise) return dbPromise
  let wasBlocked = false
  const opening: Promise<IDBPDatabase<HubDB>> = openDB<HubDB>(DB_NAME, 4, {
    // Другая вкладка со старой версией не закрывает базу: обновление ждёт, пока её закроют.
    blocked() {
      wasBlocked = true
      tellBlocked(true)
    },
    // Другой вкладке нужна новая версия базы (или «Выйти» стирает её): уступаем, следующий запрос откроет заново.
    blocking() {
      if (dbPromise === opening) dbPromise = null
      void opening.then((d) => d.close())
    },
    terminated() {
      if (dbPromise === opening) dbPromise = null
    },
    async upgrade(d, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) d.createObjectStore('kv')
      if (oldVersion < 2) {
        const store = d.createObjectStore('branchFiles', { keyPath: ['branch', 'path'] })
        store.createIndex('branch', 'branch')
        if (oldVersion === 1) {
          // Версия 1 знала только main: переносим кэш, чтобы офлайн-старт после обновления не остался пустым.
          const legacy = tx.objectStore('files' as never) as unknown as { getAll(): Promise<CachedFile[]> }
          for (const f of await legacy.getAll()) await store.put({ ...f, branch: 'main' })
          d.deleteObjectStore('files' as never)
        }
      }
      // Версия 3: очередь правок и входящие конфликты. Кэш версии 2 не трогаем.
      if (oldVersion < 3) {
        d.createObjectStore('queue', { keyPath: ['branch', 'path'] }).createIndex('branch', 'branch')
        d.createObjectStore('conflicts', { keyPath: ['branch', 'path'] }).createIndex('branch', 'branch')
      }
      // Версия 4: байты обложек по sha. Остальные хранилища не трогаем.
      if (oldVersion < 4) d.createObjectStore('covers', { keyPath: 'sha' })
    },
  })
  dbPromise = opening
  opening.then(
    () => {
      if (wasBlocked) tellBlocked(false)
    },
    () => {
      if (dbPromise === opening) dbPromise = null // следующий запрос попробует открыть снова
    },
  )
  return opening
}

export async function getCachedFiles(branch: string): Promise<CachedFile[]> {
  const rows = await (await db()).getAllFromIndex('branchFiles', 'branch', branch)
  return rows.map(({ path, sha, text }) => ({ path, sha, text }))
}

export async function putCachedFiles(branch: string, files: CachedFile[], removed: string[]): Promise<void> {
  const tx = (await db()).transaction('branchFiles', 'readwrite')
  await Promise.all([
    ...files.map((f) => tx.store.put({ ...f, branch })),
    ...removed.map((p) => tx.store.delete([branch, p])),
    tx.done,
  ])
}

/** Ветку удалили — её кэш, очередь правок и конфликты больше не нужны: писать их некуда. */
export async function dropBranchCache(branch: string): Promise<void> {
  const tx = (await db()).transaction(['branchFiles', 'queue', 'conflicts'], 'readwrite')
  const drop = async (name: 'branchFiles' | 'queue' | 'conflicts') => {
    const store = tx.objectStore(name)
    const keys = await store.index('branch').getAllKeys(branch)
    await Promise.all(keys.map((k) => store.delete(k)))
  }
  await Promise.all([drop('branchFiles'), drop('queue'), drop('conflicts'), tx.done])
  await (await db()).delete('kv', COVER_INDEX_PREFIX + branch)
  await pruneCovers().catch(() => undefined)
}

// ---------- Обложки ----------
const COVER_INDEX_PREFIX = 'coverIndex:'

/** Обложки ветки на момент последней сверки: путь covers/<slug>.<ext> → sha. Нужен офлайн, где списка файлов с сервера нет. */
export type CoverIndex = Record<string, string>

export async function getCoverIndex(branch: string): Promise<CoverIndex> {
  const v = await (await db()).get('kv', COVER_INDEX_PREFIX + branch)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

export async function putCoverIndex(branch: string, index: CoverIndex): Promise<void> {
  await (await db()).put('kv', index, COVER_INDEX_PREFIX + branch)
}

export async function getCover(sha: string): Promise<CachedCover | undefined> {
  return (await db()).get('covers', sha)
}

export async function putCover(cover: CachedCover): Promise<void> {
  await (await db()).put('covers', cover)
}

/**
 * Чистка: убрать байты обложек, чьих sha нет ни в одном индексе веток. Вызывается после каждой сверки списка
 * файлов, поэтому на устройстве остаются только обложки, которые есть в какой-то известной ветке:
 * не больше «проекты × ветки» картинок (каждая до 300 КБ), старые версии уходят при первой же сверке.
 */
export async function pruneCovers(): Promise<void> {
  const d = await db()
  const live = new Set<string>()
  for (const key of await d.getAllKeys('kv')) {
    if (typeof key !== 'string' || !key.startsWith(COVER_INDEX_PREFIX)) continue
    const idx = await getCoverIndex(key.slice(COVER_INDEX_PREFIX.length))
    for (const sha of Object.values(idx)) live.add(sha)
  }
  const tx = d.transaction('covers', 'readwrite')
  await Promise.all([...(await tx.store.getAllKeys()).filter((k) => !live.has(k)).map((k) => tx.store.delete(k)), tx.done])
}

/**
 * Запись очереди с устройства в формате этой сборки. До STATE_VERSION 2 очередь знала только проекты и поля kind
 * не было: такая запись — правка проекта. Незнакомый kind (запись новой сборки после отката) или битую запись
 * не угадываем — ошибка; getQueue такие пропускает, их забирает takeUnreadableQueued (ADR-011 §6).
 */
export function readQueued(raw: QueuedEdit): QueuedEdit {
  const r = raw as unknown as Record<string, unknown>
  const str = (k: string) => typeof r[k] === 'string'
  if (!str('branch') || !str('path') || !str('baseSha') || !str('baseText') || !str('text') || !str('queuedAt')) throw new Error('Запись очереди не разбирается')
  if (typeof r.patch !== 'object' || r.patch === null || Array.isArray(r.patch)) throw new Error('Запись очереди не разбирается')
  const kind = r.kind
  if (kind === 'project' || kind === 'idea') return raw
  if (kind === undefined) return { ...raw, kind: 'project' }
  throw new Error(`Незнакомый вид записи очереди: ${String(kind)}`)
}

const readable = (raw: QueuedEdit): QueuedEdit | undefined => {
  try {
    return readQueued(raw)
  } catch {
    return undefined
  }
}

/** Все ожидающие правки устройства, по всем веткам. Записи, которые эта сборка не понимает, пропускаются. */
export async function getQueue(): Promise<QueuedEdit[]> {
  return (await (await db()).getAll('queue')).flatMap((raw) => readable(raw) ?? [])
}

/** Запись очереди, которую эта сборка не понимает: где она и моя версия файла целиком. */
export interface UnreadableQueued {
  branch: string
  path: string
  reason: string
  mine: string
}

/**
 * Записи очереди, которые эта сборка не понимает (ADR-011 §6), с сырыми ключами. Базу не меняет: пишущая вкладка
 * сперва кладёт их во «Входящие» (putConflict), потом удаляет (dropQueuedKey) — так не теряются.
 */
export async function getUnreadableQueued(): Promise<{ key: IDBValidKey; item: UnreadableQueued }[]> {
  const d = await db()
  // Ключи и записи — одним курсором в одной транзакции: две отдельные выборки могли бы разойтись.
  const rows: { key: IDBValidKey; raw: QueuedEdit }[] = []
  for (let cur = await d.transaction('queue').store.openCursor(); cur; cur = await cur.continue()) rows.push({ key: cur.primaryKey as IDBValidKey, raw: cur.value })
  const out: { key: IDBValidKey; item: UnreadableQueued }[] = []
  rows.forEach(({ key: rawKey, raw }) => {
    try {
      readQueued(raw)
    } catch (e) {
      const r = raw as unknown as Record<string, unknown>
      const k = rawKey as unknown as unknown[]
      out.push({
        key: rawKey,
        item: {
          branch: String(typeof r.branch === 'string' ? r.branch : (k?.[0] ?? '')),
          path: String(typeof r.path === 'string' ? r.path : (k?.[1] ?? '')),
          reason: e instanceof Error ? e.message : 'Запись очереди не разбирается',
          mine: typeof r.text === 'string' ? r.text : JSON.stringify(raw, null, 2),
        },
      })
    }
  })
  return out
}

/** Удалить запись очереди по сырому ключу (для записей, которые эта сборка не понимает). */
export async function dropQueuedKey(key: IDBValidKey): Promise<void> {
  await (await db()).delete('queue', key as [string, string])
}

export async function getQueued(branch: string, path: string): Promise<QueuedEdit | undefined> {
  const raw = await (await db()).get('queue', [branch, path])
  return raw && readable(raw)
}

export async function putQueued(edit: QueuedEdit): Promise<void> {
  await (await db()).put('queue', edit)
}

export async function deleteQueued(branch: string, path: string): Promise<void> {
  await (await db()).delete('queue', [branch, path])
}

/** Все входящие конфликты устройства, по всем веткам. */
export async function getConflicts(): Promise<StoredConflict[]> {
  return (await db()).getAll('conflicts')
}

export async function getConflict(branch: string, path: string): Promise<StoredConflict | undefined> {
  return (await db()).get('conflicts', [branch, path])
}

export async function putConflict(conflict: StoredConflict): Promise<void> {
  await (await db()).put('conflicts', conflict)
}

export async function deleteConflict(branch: string, path: string): Promise<void> {
  await (await db()).delete('conflicts', [branch, path])
}

/** Какая ветка открыта на этом устройстве. Без записи — main. */
export async function getCurrentBranch(): Promise<string> {
  const v = await (await db()).get('kv', BRANCH_KEY)
  return typeof v === 'string' ? v : 'main'
}

export async function setCurrentBranch(branch: string): Promise<void> {
  await (await db()).put('kv', branch, BRANCH_KEY)
}

const STATUS_KEY = 'status'

/** Живые виджеты с устройства (для офлайна): текст status.json и когда его получили. Хранится в kv, без смены версии базы. */
export interface CachedStatus {
  text: string
  loadedAt: number
}

export async function getCachedStatus(): Promise<CachedStatus | null> {
  const v = (await (await db()).get('kv', STATUS_KEY)) as Partial<CachedStatus> | undefined
  return v && typeof v.text === 'string' && typeof v.loadedAt === 'number' ? { text: v.text, loadedAt: v.loadedAt } : null
}

/** null — виджеты ещё не собирались: запись стирается. */
export async function putCachedStatus(value: CachedStatus | null): Promise<void> {
  const d = await db()
  if (value) await d.put('kv', value, STATUS_KEY)
  else await d.delete('kv', STATUS_KEY)
}

const pendingBackground = new Set<Promise<unknown>>()
let wipeEpoch = 0

/** Номер «поколения» устройства: растёт при каждом «Выйти». Запрос, начатый до выхода, по нему видит, что базу стёрли. */
export function deviceEpoch(): number {
  return wipeEpoch
}

/**
 * Положить обложку, только если с начала запроса (epoch) устройство не стирали: иначе запись заново открыла бы
 * стёртую базу. Идущую запись «Выйти» дожидается.
 */
export async function putCoverIfCurrent(epoch: number, cover: CachedCover): Promise<void> {
  if (epoch !== wipeEpoch) return
  const p: Promise<unknown> = putCover(cover)
  pendingBackground.add(p)
  try {
    await p
  } finally {
    pendingBackground.delete(p)
  }
}

/**
 * Сохранить индекс обложек ветки и вычистить лишние картинки — в фоне, ошибки глотаются (кэш картинок необязателен).
 * «Выйти» (wipeDevice) дожидается таких записей, чтобы они не воскресили стёртую базу.
 */
export function saveCoverIndex(branch: string, index: CoverIndex): void {
  const p: Promise<unknown> = putCoverIndex(branch, index).then(pruneCovers).catch(() => undefined)
  pendingBackground.add(p)
  void p.then(() => pendingBackground.delete(p))
}

/** «Выйти»: стереть с устройства кэш данных. */
export async function wipeDevice(): Promise<void> {
  wipeEpoch++
  await Promise.all([...pendingBackground].map((p) => p.catch(() => undefined)))
  await Promise.all([...pendingBackground])
  // Не ждать открытия: если оно ждёт другие вкладки (blocked), «Выйти» зависло бы. Закроется, как только откроется.
  const opening = dbPromise
  dbPromise = null
  if (opening) void opening.then((d) => d.close(), () => undefined)
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

/** Попросить браузер не вычищать наши данные при нехватке места (ADR-004). */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    /* не поддерживается — живём без гарантии */
  }
}
