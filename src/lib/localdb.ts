// Локальное хранилище устройства (IndexedDB): кэш файлов по веткам, очередь правок и входящие конфликты (ADR-004).
// Токенов здесь нет (ADR-007). Кэш и очередь раздельны по веткам (ADR-007): правка на ветке-эксперименте уходит только в неё.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ProjectPatch } from '../data/editProject'
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

/**
 * Ожидающая правка файла (ADR-004): одна на [ветка, путь]. Новая правка того же файла сливается с ней,
 * базовая копия (версия, от которой считается правка) остаётся прежней.
 */
export interface QueuedEdit {
  branch: string
  path: string
  /** sha и текст базовой копии. */
  baseSha: string
  baseText: string
  /** Все правки, накопленные с базовой копии. */
  patch: ProjectPatch
  /** Моя версия файла: базовая копия с правкой. Её видно на экране до отправки. */
  text: string
  queuedAt: string
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
  /** Правку не удалось ни слить, ни записать: причина и моя версия файла целиком. */
  refused?: { reason: string; mine: string }
  /** Файл удалили в репо, а у меня была правка: моя версия файла. */
  deleted?: { mine: string }
}

interface HubDB extends DBSchema {
  kv: { key: string; value: unknown }
  branchFiles: { key: [string, string]; value: StoredFile; indexes: { branch: string } }
  queue: { key: [string, string]; value: QueuedEdit; indexes: { branch: string } }
  conflicts: { key: [string, string]; value: StoredConflict; indexes: { branch: string } }
}

const DB_NAME = 'tartaluga-hub'
const BRANCH_KEY = 'branch'
let dbPromise: Promise<IDBPDatabase<HubDB>> | null = null

function db() {
  dbPromise ??= openDB<HubDB>(DB_NAME, 3, {
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
    },
  })
  return dbPromise
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
}

/** Все ожидающие правки устройства, по всем веткам. */
export async function getQueue(): Promise<QueuedEdit[]> {
  return (await db()).getAll('queue')
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

/** «Выйти»: стереть с устройства кэш данных. */
export async function wipeDevice(): Promise<void> {
  if (dbPromise) (await dbPromise).close()
  dbPromise = null
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
