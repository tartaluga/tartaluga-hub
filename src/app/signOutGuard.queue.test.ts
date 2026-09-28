// Страж выхода на настоящей очереди: правка без сети через saveProject, без подмены unsentSnapshot.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetQueueMemory, useSession, type Remote } from './session'
import { answerSignOut, guardedSignOut, useSignOutGuard } from './signOutGuard'
import { ApiError, type Me } from '../lib/api'
import { getQueue, wipeDevice } from '../lib/localdb'

const ME: Me = {
  unseenSecurityEvents: 0,
  session: { authMethod: 'passkey', authAt: 1, fresh: false, createdAt: 1, expiresAt: 2, device: 'Chrome, Windows' },
}
const PATH = 'projects/a.json'
const TEXT = JSON.stringify({
  schemaVersion: 2,
  slug: 'a',
  title: 'А',
  status: 'active',
  nextStep: 'шаг',
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
})

/** Сервер с одним файлом; down — нет сети. */
function server() {
  const state = { down: false }
  const check = () => {
    if (state.down) throw new ApiError(0, 'network', 'нет сети')
  }
  const remote: Remote = {
    async me() {
      check()
      return ME
    },
    async listFiles() {
      check()
      return { head: 'h1', files: [{ path: PATH, sha: 's1' }] }
    },
    async readBlobText() {
      check()
      return TEXT
    },
    async putFile() {
      check()
      throw new Error('не нужен')
    },
    async commit() {
      throw new Error('не нужен')
    },
  }
  return { remote, state }
}

const asked = () =>
  vi.waitFor(() => {
    if (!useSignOutGuard.getState().ask) throw new Error('вопроса нет')
  })

beforeEach(async () => {
  resetQueueMemory()
  await wipeDevice()
  useSignOutGuard.setState({ ask: null })
  useSession.setState({ phase: 'booting', me: null, branch: 'main', files: [], tree: null, sync: 'idle', syncError: null, lastSync: null })
})

describe('страж выхода: настоящая очередь', () => {
  it('правка без сети через saveProject — выход спрашивает; после перезапуска (память пуста) — тоже', async () => {
    const srv = server()
    useSession.setState({ remote: srv.remote })
    await useSession.getState().boot()
    await useSession.getState().syncNow()
    srv.state.down = true
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(await getQueue()).toHaveLength(1)

    const signOut = vi.fn(async () => undefined)
    let done = guardedSignOut(signOut)
    await asked()
    expect(useSignOutGuard.getState().ask?.counts).toMatchObject({ edits: 1, conflicts: 0 })
    answerSignOut(false)
    await expect(done).resolves.toBe(false)

    // Как при сбое чтения устройства на старте: в памяти вкладки пусто, запись есть только в IndexedDB.
    resetQueueMemory()
    done = guardedSignOut(signOut)
    await asked()
    expect(useSignOutGuard.getState().ask?.counts).toMatchObject({ edits: 1, conflicts: 0 })
    answerSignOut(false)
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })
})
