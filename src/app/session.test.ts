import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSession, type Remote } from './session'
import { ApiError, type Me } from '../lib/api'
import { getCachedFiles, putCachedFiles, wipeDevice } from '../lib/localdb'

const ME: Me = {
  unseenSecurityEvents: 0,
  session: { authMethod: 'passkey', authAt: 1, fresh: false, createdAt: 1, expiresAt: 2, device: 'Chrome, Windows' },
}

type Entry = { path: string; sha: string }

function fakeRemote(tree: Entry[], blobs: Record<string, string>, fail?: ApiError, meFail?: ApiError) {
  const reads: string[] = []
  const remote: Remote = {
    async me() {
      if (meFail) throw meFail
      return ME
    },
    async listFiles() {
      if (fail) throw fail
      return { files: tree }
    },
    async readBlobText(sha) {
      reads.push(sha)
      return blobs[sha]!
    },
  }
  return { remote, reads }
}

const offline = new ApiError(0, 'network', 'нет сети')
const expired = new ApiError(401, 'unauthorized', 'Нужно войти')

beforeEach(async () => {
  await wipeDevice()
  useSession.setState({ phase: 'ready', me: ME, files: [], sync: 'idle', syncError: null, lastSync: null })
})

describe('session.refresh', () => {
  const tree: Entry[] = [
    { path: 'settings.json', sha: 's1' },
    { path: 'projects/a.json', sha: 'a1' },
    { path: 'covers/a.webp', sha: 'img' },
  ]
  const blobs = { s1: '{"s":1}', a1: '{"a":1}', a2: '{"a":2}' }

  it('берёт только текстовые файлы данных и кладёт их в кэш устройства', async () => {
    const { remote, reads } = fakeRemote(tree, blobs)
    useSession.setState({ remote })
    await useSession.getState().refresh()
    expect(reads.sort()).toEqual(['a1', 's1'])
    expect((await getCachedFiles()).map((f) => f.path).sort()).toEqual(['projects/a.json', 'settings.json'])
    expect(useSession.getState().sync).toBe('idle')
  })

  it('повторная синхронизация качает только изменившееся и убирает удалённое', async () => {
    useSession.setState({ remote: fakeRemote(tree, blobs).remote })
    await useSession.getState().refresh()
    const next = fakeRemote([{ path: 'projects/a.json', sha: 'a2' }], blobs)
    useSession.setState({ remote: next.remote })
    await useSession.getState().refresh()
    expect(next.reads).toEqual(['a2'])
    expect(useSession.getState().files).toEqual([{ path: 'projects/a.json', sha: 'a2', text: '{"a":2}' }])
  })

  it('без сети остаются данные из кэша и статус offline', async () => {
    useSession.setState({ remote: fakeRemote(tree, blobs).remote })
    await useSession.getState().refresh()
    useSession.setState({ remote: fakeRemote([], {}, offline).remote })
    await useSession.getState().refresh()
    expect(useSession.getState().sync).toBe('offline')
    expect(useSession.getState().files).toHaveLength(2)
  })

  it('сессия кончилась → sessionExpired, данные на устройстве не стираются', async () => {
    useSession.setState({ remote: fakeRemote(tree, blobs).remote })
    await useSession.getState().refresh()
    useSession.setState({ remote: fakeRemote([], {}, expired).remote })
    await useSession.getState().refresh()
    expect(useSession.getState().sync).toBe('sessionExpired')
    expect(await getCachedFiles()).toHaveLength(2)
  })
})

describe('session.boot', () => {
  it('есть сессия — хаб открыт', async () => {
    useSession.setState({ phase: 'booting', me: null, remote: fakeRemote([], {}).remote })
    await useSession.getState().boot()
    expect(useSession.getState()).toMatchObject({ phase: 'ready', me: ME })
  })

  it('нет сессии — экран входа', async () => {
    useSession.setState({ phase: 'booting', me: null, remote: fakeRemote([], {}, undefined, expired).remote })
    await useSession.getState().boot()
    expect(useSession.getState().phase).toBe('signedOut')
  })

  it('без сети, но с данными на устройстве — хаб открыт в офлайне', async () => {
    await putCachedFiles([{ path: 'settings.json', sha: 's1', text: '{}' }], [])
    useSession.setState({ phase: 'booting', me: null, remote: fakeRemote([], {}, offline, offline).remote })
    await useSession.getState().boot()
    expect(useSession.getState()).toMatchObject({ phase: 'ready', sync: 'offline', me: null })
    expect(useSession.getState().files).toHaveLength(1)
  })

  it('без сети и без данных — экран входа', async () => {
    useSession.setState({ phase: 'booting', me: null, remote: fakeRemote([], {}, offline, offline).remote })
    await useSession.getState().boot()
    expect(useSession.getState().phase).toBe('signedOut')
  })
})
