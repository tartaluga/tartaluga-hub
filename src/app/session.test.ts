import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSession, type Remote } from './session'
import { ApiError, type Me } from '../lib/api'
import { getCachedFiles, getCurrentBranch, putCachedFiles, wipeDevice } from '../lib/localdb'

const ME: Me = {
  unseenSecurityEvents: 0,
  session: { authMethod: 'passkey', authAt: 1, fresh: false, createdAt: 1, expiresAt: 2, device: 'Chrome, Windows' },
}

type Entry = { path: string; sha: string }

/** tree — дерево main или деревья по веткам; ветки, которой нет в словаре, на сервере нет (404). */
function fakeRemote(tree: Entry[] | Record<string, Entry[]>, blobs: Record<string, string>, fail?: ApiError, meFail?: ApiError) {
  const reads: string[] = []
  const remote: Remote = {
    async me() {
      if (meFail) throw meFail
      return ME
    },
    async listFiles(branch) {
      if (fail) throw fail
      const files = Array.isArray(tree) ? (branch === 'main' ? tree : undefined) : tree[branch]
      if (!files) throw new ApiError(404, 'not_found', 'Не найдено в репо данных')
      return { files }
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
  useSession.setState({ phase: 'ready', me: ME, branch: 'main', branchNotice: null, files: [], sync: 'idle', syncError: null, lastSync: null })
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
    expect((await getCachedFiles('main')).map((f) => f.path).sort()).toEqual(['projects/a.json', 'settings.json'])
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
    expect(await getCachedFiles('main')).toHaveLength(2)
  })

  it('два refresh подряд — один запрос к серверу', async () => {
    let calls = 0
    const base = fakeRemote(tree, blobs).remote
    useSession.setState({ remote: { ...base, listFiles: (b) => (calls++, base.listFiles(b)) } })
    await Promise.all([useSession.getState().refresh(), useSession.getState().refresh()])
    expect(calls).toBe(1)
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
    await putCachedFiles('main', [{ path: 'settings.json', sha: 's1', text: '{}' }], [])
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

describe('ветки (ADR-007): кэш у каждой ветки свой', () => {
  const blobs = { m1: '{"m":1}', f1: '{"f":1}', f2: '{"f":2}' }
  const trees = {
    main: [{ path: 'projects/a.json', sha: 'm1' }],
    feat: [
      { path: 'projects/a.json', sha: 'f1' },
      { path: 'projects/b.json', sha: 'f2' },
    ],
  }

  it('переключение показывает файлы ветки и не смешивает их с main', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().refresh()
    await useSession.getState().switchBranch('feat')
    expect(useSession.getState().branch).toBe('feat')
    expect(useSession.getState().files.map((f) => f.sha).sort()).toEqual(['f1', 'f2'])
    expect((await getCachedFiles('main')).map((f) => f.sha)).toEqual(['m1'])
    expect(await getCurrentBranch()).toBe('feat')
  })

  it('открытая ветка переживает перезапуск, и без сети видны её данные, а не main', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().refresh()
    await useSession.getState().switchBranch('feat')
    useSession.setState({ phase: 'booting', me: null, branch: 'main', files: [], remote: fakeRemote([], {}, offline, offline).remote })
    await useSession.getState().boot()
    expect(useSession.getState()).toMatchObject({ phase: 'ready', branch: 'feat', sync: 'offline' })
    expect(useSession.getState().files).toHaveLength(2)
  })

  it('без сети переключение сразу показывает кэш ветки', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().switchBranch('main')
    useSession.setState({ remote: fakeRemote([], {}, offline).remote })
    await useSession.getState().switchBranch('feat')
    expect(useSession.getState()).toMatchObject({ branch: 'feat', sync: 'offline' })
    expect(useSession.getState().files).toHaveLength(2)
  })

  it('ответ по main, пришедший после переключения, не попадает на экран ветки, но обновляет кэш main', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const base = fakeRemote(trees, blobs).remote
    useSession.setState({
      remote: {
        ...base,
        async listFiles(branch) {
          if (branch === 'main') await gate
          return base.listFiles(branch)
        },
      },
    })
    const slowMain = useSession.getState().refresh()
    await useSession.getState().switchBranch('feat')
    release()
    await slowMain
    expect(useSession.getState().branch).toBe('feat')
    expect(useSession.getState().files.map((f) => f.sha).sort()).toEqual(['f1', 'f2'])
    expect(useSession.getState().sync).toBe('idle')
    expect((await getCachedFiles('main')).map((f) => f.sha)).toEqual(['m1'])
  })

  it('ветку удалили в другом месте — хаб возвращается на main, кэш ветки стёрт', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().switchBranch('feat')
    useSession.setState({ remote: fakeRemote({ main: trees.main }, blobs).remote })
    await useSession.getState().refresh()
    expect(useSession.getState()).toMatchObject({ branch: 'main', sync: 'idle' })
    expect(useSession.getState().branchNotice).toContain('feat')
    expect(await getCachedFiles('feat')).toEqual([])
  })

  it('404 на main — это ошибка, а не повод куда-то переключаться', async () => {
    useSession.setState({ remote: fakeRemote({}, blobs).remote })
    await useSession.getState().refresh()
    expect(useSession.getState()).toMatchObject({ branch: 'main', sync: 'error', branchNotice: null })
  })

  it('удаление открытой ветки возвращает на main', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().branchDeleted('feat')
    expect(useSession.getState().branch).toBe('main')
    expect(useSession.getState().files.map((f) => f.sha)).toEqual(['m1'])
    expect(await getCachedFiles('feat')).toEqual([])
  })

  it('удаление другой ветки не трогает открытую', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().branchDeleted('old')
    expect(useSession.getState().branch).toBe('feat')
  })

  it('выход сбрасывает ветку на main', async () => {
    useSession.setState({ remote: fakeRemote(trees, blobs).remote })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().signOut()
    expect(useSession.getState().branch).toBe('main')
    expect(await getCurrentBranch()).toBe('main')
  })
})
