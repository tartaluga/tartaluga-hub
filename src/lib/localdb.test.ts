import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCachedFiles, getCurrentBranch, onDbBlocked, wipeDevice } from './localdb'

beforeEach(() => wipeDevice())

/** База версии 1 (до веток): kv и files с ключом path. */
async function createV1(files: { path: string; sha: string; text: string }[]): Promise<void> {
  ;(await openV1(files)).close()
}

/** Открыть базу версии 1 и держать открытой — как старая вкладка хаба, которая не уступает обновлению. */
function openV1(files: { path: string; sha: string; text: string }[] = []): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tartaluga-hub', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv')
      const store = req.result.createObjectStore('files', { keyPath: 'path' })
      for (const f of files) store.put(f)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Другая вкладка с более новой версией хаба открывает базу версии v. */
function openNewer(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tartaluga-hub', version)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('blocked'))
  })
}

describe('localdb: переход на кэш по веткам', () => {
  it('кэш версии 1 становится кэшем main и не теряется', async () => {
    await createV1([{ path: 'projects/a.json', sha: 'a1', text: '{}' }])
    expect(await getCachedFiles('main')).toEqual([{ path: 'projects/a.json', sha: 'a1', text: '{}' }])
    expect(await getCachedFiles('feat')).toEqual([])
    expect(await getCurrentBranch()).toBe('main')
  })

  it('чистая установка — пусто', async () => {
    expect(await getCachedFiles('main')).toEqual([])
  })
})

describe('localdb: несколько вкладок', () => {
  it('обновление базы ждёт старую вкладку: сообщаем об этом и открываемся, когда она закроется', async () => {
    const old = await openV1([{ path: 'projects/a.json', sha: 'a1', text: '{}' }])
    const events: boolean[] = []
    const stop = onDbBlocked((b) => events.push(b))
    try {
      const files = getCachedFiles('main')
      await vi.waitFor(() => expect(events).toEqual([true]))
      old.close()
      expect(await files).toEqual([{ path: 'projects/a.json', sha: 'a1', text: '{}' }])
      expect(events).toEqual([true, false])
    } finally {
      stop()
    }
  })

  it('новой вкладке нужна новая версия базы — эта вкладка закрывает свою и не держит обновление', async () => {
    expect(await getCachedFiles('main')).toEqual([])
    const newer = await openNewer(99)
    expect(newer.version).toBe(99)
    newer.close()
    // Своя версия теперь старее базы: открыть не выйдет, но запрос не виснет и не ломает следующие.
    await expect(getCachedFiles('main')).rejects.toThrow()
    await wipeDevice() // «Выйти» стирает базу, и хаб открывает её заново
    expect(await getCachedFiles('main')).toEqual([])
  })
})
