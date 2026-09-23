import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getCachedFiles, getCurrentBranch, wipeDevice } from './localdb'

beforeEach(() => wipeDevice())

/** База версии 1 (до веток): kv и files с ключом path. */
function createV1(files: { path: string; sha: string; text: string }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tartaluga-hub', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv')
      const store = req.result.createObjectStore('files', { keyPath: 'path' })
      for (const f of files) store.put(f)
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
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
