// Локальное хранилище устройства (IndexedDB): кэш файлов, позже очередь правок (ADR-004). Токенов здесь нет (ADR-007).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface CachedFile {
  path: string
  /** sha blob-а в git — по нему понимаем, изменился ли файл. */
  sha: string
  text: string
}

interface HubDB extends DBSchema {
  kv: { key: string; value: unknown }
  files: { key: string; value: CachedFile }
}

const DB_NAME = 'tartaluga-hub'
let dbPromise: Promise<IDBPDatabase<HubDB>> | null = null

function db() {
  dbPromise ??= openDB<HubDB>(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('kv')
      d.createObjectStore('files', { keyPath: 'path' })
    },
  })
  return dbPromise
}

export async function getCachedFiles(): Promise<CachedFile[]> {
  return (await db()).getAll('files')
}

export async function putCachedFiles(files: CachedFile[], removed: string[]): Promise<void> {
  const tx = (await db()).transaction('files', 'readwrite')
  await Promise.all([...files.map((f) => tx.store.put(f)), ...removed.map((p) => tx.store.delete(p)), tx.done])
}

/** «Выйти»: стереть с устройства кэш данных. */
export async function wipeDevice(): Promise<void> {
  const d = await db()
  d.close()
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
