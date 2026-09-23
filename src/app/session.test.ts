import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSession, type Remote } from './session'
import { ApiError, type Me } from '../lib/api'
import { EditConflict } from '../data/editProject'
import { getCachedFiles, getCurrentBranch, putCachedFiles, wipeDevice } from '../lib/localdb'

const ME: Me = {
  unseenSecurityEvents: 0,
  session: { authMethod: 'passkey', authAt: 1, fresh: false, createdAt: 1, expiresAt: 2, device: 'Chrome, Windows' },
}

type Entry = { path: string; sha: string }

/**
 * tree — дерево main или деревья по веткам; ветки, которой нет в словаре, на сервере нет (404).
 * Записи меняют эти деревья, как настоящий репо: следующая сверка видит записанное.
 */
function fakeRemote(tree: Entry[] | Record<string, Entry[]>, blobs: Record<string, string>, fail?: ApiError, meFail?: ApiError) {
  const reads: string[] = []
  const writes: string[] = []
  const trees: Record<string, Entry[]> = Array.isArray(tree) ? { main: [...tree] } : Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, [...v]]))
  let n = 0
  const remote: Remote = {
    async me() {
      if (meFail) throw meFail
      return ME
    },
    async listFiles(branch) {
      if (fail) throw fail
      const files = trees[branch]
      if (!files) throw new ApiError(404, 'not_found', 'Не найдено в репо данных')
      return { head: `head-${branch}-${n}`, files: [...files] }
    },
    async readBlobText(sha) {
      reads.push(sha)
      return blobs[sha]!
    },
    async putFile(branch, path, text, expected) {
      writes.push(`put ${branch} ${path}`)
      // Обновление с устаревшим sha отклоняется, как у GitHub.
      if (expected !== undefined && trees[branch]?.find((f) => f.path === path)?.sha !== expected) throw new ApiError(409, 'conflict', 'Файл изменился')
      const sha = `w${++n}`
      blobs[sha] = text
      trees[branch] = [...(trees[branch] ?? []).filter((f) => f.path !== path), { path, sha }]
      return { sha }
    },
    async commit(branch, changes, expectedHead) {
      writes.push(`commit ${branch} ${expectedHead} ${changes.map((c) => c.path).join(',')}`)
      const gone = new Set(changes.map((c) => c.path))
      trees[branch] = (trees[branch] ?? []).filter((f) => !gone.has(f.path))
      n++
      return { head: `head-${branch}-${n}`, shas: {} }
    },
  }
  return { remote, reads, writes, trees }
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

describe('запись: создание и удаление файлов', () => {
  const blobs = { a1: '{"a":1}', c1: 'img' }
  const tree = [
    { path: 'projects/a.json', sha: 'a1' },
    { path: 'covers/a.webp', sha: 'c1' },
  ]

  it('новый файл сразу виден на экране и в кэше ветки, запись идёт в открытую ветку', async () => {
    const r = fakeRemote({ main: [], feat: [] }, blobs)
    useSession.setState({ remote: r.remote })
    await useSession.getState().switchBranch('feat')
    await useSession.getState().createFile('projects/b.json', '{"b":1}')
    expect(r.writes).toEqual(['put feat projects/b.json'])
    expect(useSession.getState().files.map((f) => f.path)).toContain('projects/b.json')
    expect((await getCachedFiles('feat')).map((f) => f.path)).toContain('projects/b.json')
    expect(await getCachedFiles('main')).toEqual([])
  })

  it('удаление — один коммит от известного head, только существующие пути', async () => {
    const r = fakeRemote(tree, blobs)
    useSession.setState({ remote: r.remote })
    await useSession.getState().refresh()
    await useSession.getState().deleteFiles(() => ['projects/a.json', 'covers/a.webp', 'covers/a.jpg'], 'm')
    expect(r.writes).toEqual(['commit main head-main-0 projects/a.json,covers/a.webp'])
    expect(useSession.getState().files).toEqual([])
    expect(useSession.getState().tree?.head).toBe('head-main-1')
  })

  it('ветку сдвинули — сверка и одна повторная попытка от нового head', async () => {
    const r = fakeRemote(tree, blobs)
    let calls = 0
    useSession.setState({
      remote: {
        ...r.remote,
        async commit(branch, changes, expectedHead, message) {
          if (calls++ === 0) throw new ApiError(409, 'conflict', 'Данные уже изменили')
          return r.remote.commit(branch, changes, expectedHead, message)
        },
      },
    })
    await useSession.getState().refresh()
    useSession.setState({ tree: { head: 'stale', paths: ['projects/a.json'] } })
    await useSession.getState().deleteFiles(() => ['projects/a.json'], 'm')
    expect(calls).toBe(2)
    expect(r.writes).toEqual(['commit main head-main-0 projects/a.json'])
  })

  it('два конфликта подряд — ошибка, а не бесконечные повторы', async () => {
    const r = fakeRemote(tree, blobs)
    let calls = 0
    useSession.setState({
      remote: {
        ...r.remote,
        async commit() {
          calls++
          throw new ApiError(409, 'conflict', 'Данные уже изменили')
        },
      },
    })
    await useSession.getState().refresh()
    await expect(useSession.getState().deleteFiles(() => ['projects/a.json'], 'm')).rejects.toMatchObject({ status: 409 })
    expect(calls).toBe(2)
  })

  it('другая ошибка не повторяется', async () => {
    const r = fakeRemote(tree, blobs)
    let calls = 0
    useSession.setState({
      remote: {
        ...r.remote,
        async commit() {
          calls++
          throw new ApiError(422, 'validation', 'нет')
        },
      },
    })
    await useSession.getState().refresh()
    await expect(useSession.getState().deleteFiles(() => ['projects/a.json'], 'm')).rejects.toMatchObject({ status: 422 })
    expect(calls).toBe(1)
  })

  it('без сети удаление не уходит и сообщает об этом', async () => {
    useSession.setState({ remote: fakeRemote([], {}, offline).remote, tree: null })
    await expect(useSession.getState().deleteFiles(() => ['projects/a.json'], 'm')).rejects.toMatchObject({ status: 0 })
  })

  it('удалять нечего (уже удалили в другом месте) — успех без коммита', async () => {
    const r = fakeRemote([], blobs)
    useSession.setState({ remote: r.remote })
    await useSession.getState().refresh()
    await useSession.getState().deleteFiles(() => ['projects/a.json'], 'm')
    expect(r.writes).toEqual([])
  })
})

describe('правка проекта (saveProject)', () => {
  const file = (over: object = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      slug: 'a',
      title: 'А',
      status: 'active',
      nextStep: 'шаг',
      future: 1,
      createdAt: '2026-09-01T10:00:00+03:00',
      updatedAt: '2026-09-01T10:00:00+03:00',
      ...over,
    })
  const setup = () => {
    const r = fakeRemote([{ path: 'projects/a.json', sha: 'a1' }], { a1: file() })
    useSession.setState({ remote: r.remote })
    return r
  }
  const data = () => JSON.parse(useSession.getState().files.find((f) => f.path === 'projects/a.json')!.text)

  it('пишет от известного sha, незнакомые поля остаются, экран и кэш обновляются', async () => {
    const r = setup()
    await useSession.getState().refresh()
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(r.writes).toEqual(['put main projects/a.json'])
    expect(data()).toMatchObject({ title: 'Б', future: 1, nextStep: 'шаг' })
    expect(data().updatedAt).not.toBe('2026-09-01T10:00:00+03:00')
    expect((await getCachedFiles('main')).find((f) => f.path === 'projects/a.json')!.text).toContain('"Б"')
  })

  it('правки, пришедшие во время записи, уходят следующим одним коммитом', async () => {
    const r = setup()
    await useSession.getState().refresh()
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const put = r.remote.putFile
    r.remote.putFile = async (...a) => {
      await gate
      return put(...a)
    }
    const s = useSession.getState()
    const first = s.saveProject('a', { title: 'Б' })
    await Promise.resolve()
    await Promise.resolve()
    const second = s.saveProject('a', { title: 'В' })
    const third = s.saveProject('a', { nextStep: 'новый' })
    release()
    await Promise.all([first, second, third])
    expect(r.writes).toEqual(['put main projects/a.json', 'put main projects/a.json'])
    expect(data()).toMatchObject({ title: 'В', nextStep: 'новый' })
  })

  it('файл изменили в другом месте, другое поле — правка накладывается на свежую версию', async () => {
    const blobs: Record<string, string> = { a1: file() }
    const r = fakeRemote([{ path: 'projects/a.json', sha: 'a1' }], blobs)
    useSession.setState({ remote: r.remote })
    await useSession.getState().refresh()
    blobs.ext = file({ nextStep: 'с телефона' })
    r.trees.main = [{ path: 'projects/a.json', sha: 'ext' }]
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(r.writes).toEqual(['put main projects/a.json', 'put main projects/a.json'])
    expect(data()).toMatchObject({ title: 'Б', nextStep: 'с телефона' })
  })

  it('то же поле поменяли по-другому — EditConflict, второй записи нет, на экране свежая версия', async () => {
    const blobs: Record<string, string> = { a1: file() }
    const r = fakeRemote([{ path: 'projects/a.json', sha: 'a1' }], blobs)
    useSession.setState({ remote: r.remote })
    await useSession.getState().refresh()
    blobs.ext = file({ title: 'С телефона' })
    r.trees.main = [{ path: 'projects/a.json', sha: 'ext' }]
    const err = await useSession.getState().saveProject('a', { title: 'Б' }).catch((e) => e)
    expect(err).toBeInstanceOf(EditConflict)
    expect(err.fields).toEqual(['title'])
    expect(r.writes).toEqual(['put main projects/a.json'])
    expect(data().title).toBe('С телефона')
  })

  it('в свежей версии уже наша правка (ответ прошлой попытки потерялся) — второй записи нет', async () => {
    const blobs: Record<string, string> = { a1: file() }
    const r = fakeRemote([{ path: 'projects/a.json', sha: 'a1' }], blobs)
    useSession.setState({ remote: r.remote })
    await useSession.getState().refresh()
    blobs.ext = file({ title: 'Б' })
    r.trees.main = [{ path: 'projects/a.json', sha: 'ext' }]
    await useSession.getState().saveProject('a', { title: 'Б' })
    expect(r.writes).toEqual(['put main projects/a.json'])
  })

  it('файл с версией формата выше нашей не правится', async () => {
    const r = fakeRemote([{ path: 'projects/a.json', sha: 'a1' }], { a1: file({ schemaVersion: 2 }) })
    useSession.setState({ remote: r.remote })
    await useSession.getState().refresh()
    await expect(useSession.getState().saveProject('a', { title: 'Б' })).rejects.toThrow(/v2/)
    expect(r.writes).toEqual([])
  })

  it('ошибка одной записи не блокирует следующие', async () => {
    const r = setup()
    await useSession.getState().refresh()
    const put = r.remote.putFile
    let fail = true
    r.remote.putFile = async (...a) => {
      if (fail) {
        fail = false
        throw offline
      }
      return put(...a)
    }
    await expect(useSession.getState().saveProject('a', { title: 'Б' })).rejects.toBe(offline)
    await useSession.getState().saveProject('a', { title: 'В' })
    expect(data().title).toBe('В')
  })
})
