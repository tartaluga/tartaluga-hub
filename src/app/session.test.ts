import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSession } from './session'
import { GitHubClient, GitHubError, type TreeEntry } from '../lib/github'
import { getCachedFiles, wipeDevice } from '../lib/localdb'

function fakeClient(tree: TreeEntry[], blobs: Record<string, string>, fail?: GitHubError) {
  const reads: string[] = []
  const client = {
    async listFiles() {
      if (fail) throw fail
      return { commitSha: 'H', files: tree }
    },
    async readBlobText(sha: string) {
      reads.push(sha)
      return blobs[sha]!
    },
  } as unknown as GitHubClient
  return { client, reads }
}

beforeEach(async () => {
  await wipeDevice()
  useSession.setState({ phase: 'ready', files: [], sync: 'idle', syncError: null, lastSync: null })
})

describe('session.refresh', () => {
  const tree: TreeEntry[] = [
    { path: 'settings.json', sha: 's1', size: 1 },
    { path: 'projects/a.json', sha: 'a1', size: 1 },
    { path: 'covers/a.webp', sha: 'img', size: 1 },
    { path: 'README.md', sha: 'md', size: 1 },
  ]
  const blobs = { s1: '{"s":1}', a1: '{"a":1}', a2: '{"a":2}' }

  it('берёт только файлы данных и кладёт их в кэш устройства', async () => {
    const { client, reads } = fakeClient(tree, blobs)
    useSession.setState({ client })
    await useSession.getState().refresh()
    expect(reads.sort()).toEqual(['a1', 's1'])
    expect((await getCachedFiles()).map((f) => f.path).sort()).toEqual(['projects/a.json', 'settings.json'])
    expect(useSession.getState().sync).toBe('idle')
  })

  it('повторная синхронизация качает только изменившееся и убирает удалённое', async () => {
    useSession.setState({ client: fakeClient(tree, blobs).client })
    await useSession.getState().refresh()

    const next = fakeClient([{ path: 'projects/a.json', sha: 'a2', size: 1 }], blobs)
    useSession.setState({ client: next.client })
    await useSession.getState().refresh()

    expect(next.reads).toEqual(['a2'])
    expect(useSession.getState().files).toEqual([{ path: 'projects/a.json', sha: 'a2', text: '{"a":2}' }])
  })

  it('без сети остаются данные из кэша и статус offline', async () => {
    useSession.setState({ client: fakeClient(tree, blobs).client })
    await useSession.getState().refresh()
    useSession.setState({ client: fakeClient([], {}, new GitHubError('network', 'нет сети')).client })
    await useSession.getState().refresh()
    expect(useSession.getState().sync).toBe('offline')
    expect(useSession.getState().files).toHaveLength(2)
  })

  it('отозванный токен → tokenInvalid, данные не стираются', async () => {
    useSession.setState({ client: fakeClient(tree, blobs).client })
    await useSession.getState().refresh()
    useSession.setState({ client: fakeClient([], {}, new GitHubError('unauthorized', 'Bad credentials', 401)).client })
    await useSession.getState().refresh()
    expect(useSession.getState().sync).toBe('tokenInvalid')
    expect(await getCachedFiles()).toHaveLength(2)
  })
})

describe('session.signIn', () => {
  it('отбраковывает строку, не похожую на токен, без запросов в сеть', async () => {
    expect(await useSession.getState().signIn('пароль123')).toMatch(/не похоже на токен/)
  })
})
