// Локальное хранилище устройства (IndexedDB): кэш файлов по веткам, позже очередь правок (ADR-004). Токенов здесь нет (ADR-007).
// Кэш и очередь раздельны по веткам (ADR-007): правка на ветке-эксперименте уходит только в неё.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface CachedFile {
  path: string
  /** sha blob-а в git — по нему понимаем, изменился ли файл. */
  sha: string
  text: string
}

interface StoredFile extends CachedFile {
  branch: string
}

interface HubDB extends DBSchema {
  kv: { key: string; value: unknown }
  branchFiles: { key: [string, string]; value: StoredFile; indexes: { branch: string } }
}

const DB_NAME = 'tartaluga-hub'
const BRANCH_KEY = 'branch'
let dbPromise: Promise<IDBPDatabase<HubDB>> | null = null

function db() {
  dbPromise ??= openDB<HubDB>(DB_NAME, 2, {
    async upgrade(d, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) d.createObjectStore('kv')
      const store = d.createObjectStore('branchFiles', { keyPath: ['branch', 'path'] })
      store.createIndex('branch', 'branch')
      if (oldVersion === 1) {
        // Версия 1 знала только main: переносим кэш, чтобы офлайн-старт после обновления не остался пустым.
        const legacy = tx.objectStore('files' as never) as unknown as { getAll(): Promise<CachedFile[]> }
        for (const f of await legacy.getAll()) await store.put({ ...f, branch: 'main' })
        d.deleteObjectStore('files' as never)
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

/** Ветку удалили — её кэш больше не нужен. */
export async function dropBranchCache(branch: string): Promise<void> {
  const tx = (await db()).transaction('branchFiles', 'readwrite')
  const keys = await tx.store.index('branch').getAllKeys(branch)
  await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done])
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
