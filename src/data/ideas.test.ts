import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { QueueConflict, resetQueueMemory, useSession, type Remote } from '../app/session'
import { ApiError, type Me } from '../lib/api'
import { getCachedFiles, getConflicts, getQueue, wipeDevice } from '../lib/localdb'
import type { Idea } from '../schema/types'
import {
  applyIdeaPatch,
  DELETED_ONLY_ON_DEVICE,
  ideaErrorText,
  buildInbox,
  createIdea,
  deleteIdea,
  deleteProject,
  filterIdeas,
  firstLine,
  makeProjectFromIdea,
  newIdeaDraft,
  projectFromIdeaDraft,
  mergeIdeaPatch,
  saveIdea,
  shortDate,
  textExtendsTitle,
  titleFromIdea,
  unlinkIdeasChanges,
} from './ideas'
import { parseFile, type WithUnknown } from './model'

const ID1 = '01J8Z6Y0000000000000000001'
const ID2 = '01J8Z6Y0000000000000000002'
const ID3 = '01J8Z6Y0000000000000000003'

function ideaFile(id: string, extra: object = {}, sha = `sha-${id}`) {
  return {
    path: `ideas/${id}.json`,
    sha,
    text: JSON.stringify({ schemaVersion: 1, id, text: `Идея ${id.slice(-1)}`, createdAt: '2026-09-20T10:00:00+03:00', ...extra }),
  }
}

function projectFile(slug: string, extra: object = {}) {
  return {
    path: `projects/${slug}.json`,
    sha: `sha-${slug}`,
    text: JSON.stringify({
      schemaVersion: 2,
      slug,
      title: `Проект ${slug}`,
      status: 'active',
      createdAt: '2026-09-01T10:00:00+03:00',
      updatedAt: '2026-09-01T10:00:00+03:00',
      ...extra,
    }),
  }
}

describe('разбор', () => {
  it('firstLine берёт первую непустую строку и схлопывает пробелы', () => {
    expect(firstLine('\n  \n  Бот   для  пар \nвторая')).toBe('Бот для пар')
    expect(firstLine('   ')).toBe('')
  })

  it('textExtendsTitle: текст длиннее заголовка — только если есть что-то кроме первой строки', () => {
    expect(textExtendsTitle('Бот для пар')).toBe(false)
    expect(textExtendsTitle('  Бот   для пар \n\n  ')).toBe(false)
    expect(textExtendsTitle('Бот для пар\nподробности')).toBe(true)
    expect(textExtendsTitle('\nБот\n\nещё')).toBe(true)
    expect(textExtendsTitle('')).toBe(false)
  })

  it('shortDate — дата как записана, без пересчёта поясов', () => {
    expect(shortDate('2026-09-23T23:59:00+03:00')).toBe('23.09')
    expect(shortDate('мусор')).toBe('')
  })

  it('buildInbox: новые сверху, название проекта, «проект удалён», битые файлы отдельно', () => {
    const inbox = buildInbox([
      ideaFile(ID1, { createdAt: '2026-09-11T10:00:00+03:00', project: 'hub' }),
      ideaFile(ID2, { createdAt: '2026-09-23T10:00:00+03:00' }),
      ideaFile(ID3, { createdAt: '2026-09-15T10:00:00+03:00', project: 'gone' }),
      { path: 'ideas/BROKEN.json', sha: 'x', text: '{' },
      projectFile('hub'),
      projectFile('old', { status: 'archived', title: 'А-архив' }),
      projectFile('cafe', { fromIdea: { ideaId: ID3, text: 'Сайт для кофейни\nподробности', createdAt: '2026-08-01T10:00:00+03:00' }, createdAt: '2026-08-02T10:00:00+03:00' }),
      { path: 'settings.json', sha: 's', text: '{"schemaVersion":1,"tags":[]}' },
    ])
    expect(inbox.ideas.map((i) => i.id)).toEqual([ID2, ID3, ID1])
    expect(inbox.ideas[2]!.projectTitle).toBe('Проект hub')
    expect(inbox.ideas[1]!.project).toBe('gone')
    expect(inbox.ideas[1]!.projectTitle).toBeNull()
    expect(inbox.broken.map((b) => b.path)).toEqual(['ideas/BROKEN.json'])
    // Архив — в конце списка для привязки.
    expect(inbox.projects.map((p) => p.slug)).toEqual(['cafe', 'hub', 'old'])
    expect(inbox.fromIdeas).toEqual([{ slug: 'cafe', title: 'Проект cafe', ideaTitle: 'Сайт для кофейни', at: '2026-08-02T10:00:00+03:00' }])
  })

  it('идея в формате новее сборки — только чтение с причиной', () => {
    const [idea] = buildInbox([ideaFile(ID1, { schemaVersion: 5 })]).ideas
    expect(idea!.readOnly).toBe(true)
    expect(idea!.reason).toMatch(/v5/)
  })

  it('filterIdeas', () => {
    const { ideas } = buildInbox([ideaFile(ID1, { project: 'hub' }), ideaFile(ID2)])
    expect(filterIdeas(ideas, 'all')).toHaveLength(2)
    expect(filterIdeas(ideas, 'free').map((i) => i.id)).toEqual([ID2])
    expect(filterIdeas(ideas, 'linked').map((i) => i.id)).toEqual([ID1])
  })
})

describe('черновики и правки', () => {
  const now = new Date(2026, 8, 23, 14, 32)

  it('newIdeaDraft: файл по схеме, пустое и слишком длинное — ошибка', () => {
    const d = newIdeaDraft('  Мини-игра на 404\nподробнее  ', now, ID1)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.path).toBe(`ideas/${ID1}.json`)
    const parsed = parseFile(d.path, '', d.text)
    expect(parsed.ok && parsed.data).toMatchObject({ schemaVersion: 1, id: ID1, text: 'Мини-игра на 404\nподробнее' })
    expect(newIdeaDraft('   \n ', now)).toEqual({ ok: false, error: 'Пустую идею не сохранить' })
    expect(newIdeaDraft('x'.repeat(2001), now).ok).toBe(false)
  })

  it('newIdeaDraft без id выдаёт ULID', () => {
    const d = newIdeaDraft('Идея', now)
    expect(d.ok && d.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('applyIdeaPatch: текст, привязка, отвязка; незнакомые поля живы; updatedAt ставится', () => {
    const prev = { schemaVersion: 1, id: ID1, text: 'Старое', createdAt: '2026-09-20T10:00:00+03:00', future: { x: 1 } } as WithUnknown<Idea>
    const linked = applyIdeaPatch(prev, { text: ' Новое ', project: 'hub' }, now)
    expect(linked.ok && linked.data).toMatchObject({ text: 'Новое', project: 'hub', future: { x: 1 } })
    expect(linked.ok && linked.data.updatedAt).toMatch(/^2026-09-23T14:32:00/)
    expect(prev.text).toBe('Старое')
    if (!linked.ok) return
    const unlinked = applyIdeaPatch(linked.data, { project: null }, now)
    expect(unlinked.ok && 'project' in unlinked.data).toBe(false)
    expect(applyIdeaPatch(prev, { text: '  ' }, now).ok).toBe(false)
    expect(applyIdeaPatch(prev, { project: 'Не slug' }, now)).toEqual({ ok: false, error: 'Идея не прошла проверку схемой — не сохранено' })
  })

  it('applyIdeaPatch без изменений — changed: false, updatedAt не трогается', () => {
    const prev = { schemaVersion: 1, id: ID1, text: 'Старое', project: 'hub', createdAt: '2026-09-20T10:00:00+03:00' } as WithUnknown<Idea>
    for (const patch of [{ text: ' Старое ' }, { project: 'hub' }, { text: 'Старое', project: 'hub' }, {}]) {
      const r = applyIdeaPatch(prev, patch, now)
      expect(r).toEqual({ ok: true, changed: false, data: prev })
    }
    expect(applyIdeaPatch(prev, { project: null }, now)).toMatchObject({ ok: true, changed: true })
  })

  it('mergeIdeaPatch: поля второй правки поверх первой, непереданные остаются', () => {
    expect(mergeIdeaPatch({ text: 'A' }, { project: 'hub' })).toEqual({ text: 'A', project: 'hub' })
    expect(mergeIdeaPatch({ text: 'A', project: 'hub' }, { text: 'B' })).toEqual({ text: 'B', project: 'hub' })
    expect(mergeIdeaPatch({ project: 'hub' }, { project: null })).toEqual({ project: null })
    expect(mergeIdeaPatch({}, {})).toEqual({})
  })

  it('titleFromIdea режет до 120 символов', () => {
    expect(titleFromIdea('Бот\nподробно')).toBe('Бот')
    const t = titleFromIdea('я'.repeat(300))
    expect(t).toHaveLength(120)
    expect(t.endsWith('…')).toBe(true)
  })

  it('projectFromIdeaDraft: fromIdea и теги идеи, slug свободный', () => {
    const idea: Idea = { schemaVersion: 1, id: ID1, text: 'Бот расписания\nпар', tags: ['t1'], createdAt: '2026-09-20T10:00:00+03:00' }
    const d = projectFromIdeaDraft(idea, { title: 'Бот расписания', status: 'active', nextStep: '' }, ['bot-raspisaniya'], now)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.slug).toBe('bot-raspisaniya-2')
    const parsed = parseFile(d.path, '', d.text)
    expect(parsed.ok && parsed.data).toMatchObject({
      schemaVersion: 2,
      title: 'Бот расписания',
      tags: ['t1'],
      fromIdea: { ideaId: ID1, text: 'Бот расписания\nпар', createdAt: '2026-09-20T10:00:00+03:00' },
    })
    expect(projectFromIdeaDraft(idea, { title: ' ', status: 'active', nextStep: '' }, [], now)).toEqual({ ok: false, error: 'Нужно название' })
  })

  it('unlinkIdeasChanges: только идеи этого проекта, новее сборки не трогаем', () => {
    const changes = unlinkIdeasChanges(
      'hub',
      [ideaFile(ID1, { project: 'hub' }), ideaFile(ID2, { project: 'other' }), ideaFile(ID3, { project: 'hub', schemaVersion: 9 }), projectFile('hub')],
      now,
    )
    expect(changes.map((c) => c.path)).toEqual([`ideas/${ID1}.json`])
    const text = (changes[0] as { text: string }).text
    expect(JSON.parse(text).project).toBeUndefined()
  })
})

// ---------- Запись через сессию ----------

const ME: Me = {
  unseenSecurityEvents: 0,
  session: { authMethod: 'passkey', authAt: 1, fresh: false, createdAt: 1, expiresAt: 2, device: 'Chrome, Windows' },
}

type Entry = { path: string; sha: string }

/** Репо в памяти: записи меняют дерево, следующая сверка видит записанное. */
function fakeRepo(files: { path: string; sha: string; text: string }[]) {
  const blobs: Record<string, string> = Object.fromEntries(files.map((f) => [f.sha, f.text]))
  let tree: Entry[] = files.map(({ path, sha }) => ({ path, sha }))
  let n = 0
  const log: string[] = []
  // down — нет сети; lose — запись дошла, а ответ потерялся (один раз).
  const hooks: { beforePut?: () => void; failCommit?: ApiError[]; failList?: ApiError; down?: boolean; lose?: boolean } = {}
  const net = () => {
    if (hooks.down) throw new ApiError(0, 'network', 'нет сети')
  }
  const write = (path: string, text: string) => {
    const sha = `w${++n}`
    blobs[sha] = text
    tree = [...tree.filter((f) => f.path !== path), { path, sha }]
    return sha
  }
  const remote: Remote = {
    async me() {
      return ME
    },
    async listFiles() {
      net()
      if (hooks.failList) throw hooks.failList
      return { head: `h${n}`, files: [...tree] }
    },
    async readBlobText(sha) {
      return blobs[sha]!
    },
    async putFile(_b, path, text, expected) {
      net()
      hooks.beforePut?.()
      hooks.beforePut = undefined
      log.push(`put ${path}`)
      const cur = tree.find((f) => f.path === path)
      if (expected !== undefined && cur?.sha !== expected) throw new ApiError(409, 'conflict', 'Файл изменился')
      if (expected === undefined && cur && blobs[cur.sha] !== text) throw new ApiError(409, 'conflict', 'Файл уже есть')
      const sha = cur && expected === undefined ? cur.sha : write(path, text)
      if (hooks.lose) {
        hooks.lose = false
        throw new ApiError(0, 'network', 'ответ потерялся')
      }
      return { sha }
    },
    async commit(_b, changes, expectedHead) {
      log.push(`commit ${expectedHead} ${changes.map((c) => c.path).join(',')}`)
      const fail = hooks.failCommit?.shift()
      if (fail) throw fail
      if (expectedHead !== `h${n}`) throw new ApiError(409, 'conflict', 'Ветку сдвинули')
      const shas: Record<string, string> = {}
      for (const c of changes) {
        if ('text' in c && c.text !== null) shas[c.path] = write(c.path, c.text)
        else tree = tree.filter((f) => f.path !== c.path)
      }
      n++
      return { head: `h${n}`, shas }
    },
  }
  return {
    remote,
    log,
    hooks,
    text: (path: string) => {
      const e = tree.find((f) => f.path === path)
      return e ? blobs[e.sha] : undefined
    },
    /** Правка «с другого устройства». */
    external: (path: string, text: string) => {
      write(path, text)
      n++
    },
  }
}

async function start(files: { path: string; sha: string; text: string }[]) {
  const repo = fakeRepo(files)
  useSession.setState({ phase: 'ready', me: ME, branch: 'main', branchNotice: null, files: [], tree: null, sync: 'idle', syncError: null, lastSync: null, remote: repo.remote })
  await useSession.getState().refresh()
  return repo
}

const onScreen = (path: string) => useSession.getState().files.find((f) => f.path === path)

beforeEach(async () => {
  resetQueueMemory()
  await wipeDevice()
})

describe('запись идей', () => {
  it('createIdea: файл в репо и сразу на экране; повтор того же черновика — успех', async () => {
    const repo = await start([])
    const d = newIdeaDraft('Новая', new Date(), ID1)
    if (!d.ok) throw new Error(d.error)
    await createIdea(d)
    await createIdea(d)
    expect(repo.text(d.path)).toBe(d.text)
    expect(onScreen(d.path)?.text).toBe(d.text)
  })

  it('saveIdea: пишет с sha, обновляет экран и кэш устройства', async () => {
    const repo = await start([ideaFile(ID1)])
    await saveIdea(ID1, { text: 'Правка' })
    expect(JSON.parse(repo.text(`ideas/${ID1}.json`)!).text).toBe('Правка')
    expect(JSON.parse(onScreen(`ideas/${ID1}.json`)!.text).text).toBe('Правка')
    const cached = await getCachedFiles('main')
    expect(JSON.parse(cached.find((f) => f.path === `ideas/${ID1}.json`)!.text).text).toBe('Правка')
  })

  it('saveIdea: две правки подряд идут по очереди, без конфликта с собой', async () => {
    const repo = await start([ideaFile(ID1)])
    await Promise.all([saveIdea(ID1, { text: 'Раз' }), saveIdea(ID1, { project: 'hub' })])
    expect(JSON.parse(repo.text(`ideas/${ID1}.json`)!)).toMatchObject({ text: 'Раз', project: 'hub' })
  })

  it('saveIdea: файл изменили в другом поле — правка переносится на свежую версию', async () => {
    const repo = await start([ideaFile(ID1)])
    const path = `ideas/${ID1}.json`
    repo.hooks.beforePut = () => repo.external(path, JSON.stringify({ ...JSON.parse(repo.text(path)!), project: 'hub' }))
    await saveIdea(ID1, { text: 'Мой текст' })
    expect(JSON.parse(repo.text(path)!)).toMatchObject({ text: 'Мой текст', project: 'hub' })
  })

  it('saveIdea: тот же текст поменяли иначе — конфликт во «Входящих», чужая правка цела', async () => {
    const repo = await start([ideaFile(ID1)])
    const path = `ideas/${ID1}.json`
    repo.hooks.beforePut = () => repo.external(path, JSON.stringify({ ...JSON.parse(repo.text(path)!), text: 'Чужой' }))
    await expect(saveIdea(ID1, { text: 'Мой' })).rejects.toBeInstanceOf(QueueConflict)
    expect(JSON.parse(repo.text(path)!).text).toBe('Чужой')
    expect(JSON.parse(onScreen(path)!.text).text).toBe('Чужой')
    const [c] = await getConflicts()
    expect(c).toMatchObject({ path, title: 'Чужой', labels: ['текст'], items: [{ kind: 'field', path: ['text'], local: 'Мой', remote: 'Чужой' }] })
    expect(await getQueue()).toEqual([])
  })

  it('saveIdea: правка без изменений — без записи', async () => {
    const repo = await start([ideaFile(ID1, { project: 'hub' })])
    await saveIdea(ID1, { text: 'Идея 1', project: 'hub' })
    expect(repo.log).toEqual([])
  })

  it('saveIdea: идея новее сборки не перезаписывается', async () => {
    const repo = await start([ideaFile(ID1, { schemaVersion: 9 })])
    await expect(saveIdea(ID1, { text: 'x' })).rejects.toMatchObject({ status: 422 })
    expect(repo.log).toEqual([])
  })

  it('deleteIdea: удаляет файл одним коммитом', async () => {
    const repo = await start([ideaFile(ID1), ideaFile(ID2)])
    await deleteIdea(ID1)
    expect(repo.text(`ideas/${ID1}.json`)).toBeUndefined()
    expect(onScreen(`ideas/${ID1}.json`)).toBeUndefined()
    expect(onScreen(`ideas/${ID2}.json`)).toBeDefined()
  })
})

const commits = (repo: { log: string[] }) => repo.log.filter((l) => l.startsWith('commit'))

describe('сделать проектом', () => {
  const idea: Idea = { schemaVersion: 1, id: ID1, text: 'Бот расписания', createdAt: '2026-09-20T10:00:00+03:00' }
  const draft = () => {
    const d = projectFromIdeaDraft(idea, { title: 'Бот расписания', status: 'active', nextStep: '' }, [])
    if (!d.ok) throw new Error(d.error)
    return d
  }

  const source = () => ideaFile(ID1, { text: idea.text, createdAt: idea.createdAt })

  it('проект и удаление идеи одним коммитом; на экране сразу проект без идеи', async () => {
    const repo = await start([source()])
    const d = draft()
    await makeProjectFromIdea(idea, d)
    expect(repo.log.filter((l) => l.startsWith('commit'))).toEqual([`commit h0 ${d.path},ideas/${ID1}.json`])
    expect(JSON.parse(repo.text(d.path)!).fromIdea.ideaId).toBe(ID1)
    expect(repo.text(`ideas/${ID1}.json`)).toBeUndefined()
    expect(onScreen(d.path)?.text).toBe(d.text)
    expect(onScreen(`ideas/${ID1}.json`)).toBeUndefined()
  })

  it('ветку сдвинули — одна повторная попытка от свежего дерева', async () => {
    const repo = await start([source()])
    repo.external('ideas/' + ID2 + '.json', ideaFile(ID2).text)
    await makeProjectFromIdea(idea, draft())
    expect(repo.log.filter((l) => l.startsWith('commit'))).toHaveLength(2)
    expect(repo.text(`ideas/${ID1}.json`)).toBeUndefined()
  })

  it('повтор после обрыва: проект уже создан тем же черновиком — успех без второго коммита', async () => {
    const repo = await start([source()])
    const d = draft()
    await makeProjectFromIdea(idea, d)
    await makeProjectFromIdea(idea, d)
    expect(repo.log.filter((l) => l.startsWith('commit'))).toHaveLength(1)
  })

  it('slug занят другим проектом — отказ без коммита', async () => {
    const d = draft()
    const repo = await start([source(), { path: d.path, sha: 'other', text: projectFile(d.slug).text }])
    await expect(makeProjectFromIdea(idea, d)).rejects.toMatchObject({ status: 409, code: 'slug_taken' })
    expect(repo.log).toEqual([])
    expect(repo.text(`ideas/${ID1}.json`)).toBeDefined()
  })

  it('идею изменили после сборки черновика — отказ без коммита, правка идеи цела', async () => {
    const repo = await start([source()])
    repo.external(`ideas/${ID1}.json`, ideaFile(ID1, { text: 'Бот расписания и звонков', createdAt: idea.createdAt }).text)
    await useSession.getState().refresh()
    await expect(makeProjectFromIdea(idea, draft())).rejects.toMatchObject({ status: 409, code: 'idea_changed' })
    expect(commits(repo)).toEqual([])
    expect(JSON.parse(repo.text(`ideas/${ID1}.json`)!).text).toBe('Бот расписания и звонков')
  })

  it('идею изменили между попытками (409 → сверка) — повтора нет, правка идеи цела', async () => {
    const repo = await start([source()])
    repo.hooks.failCommit = [new ApiError(409, 'conflict', 'Ветку сдвинули')]
    const commit = repo.remote.commit
    repo.remote.commit = async (...args) => {
      if (repo.hooks.failCommit?.length) repo.external(`ideas/${ID1}.json`, ideaFile(ID1, { text: 'Другое', createdAt: idea.createdAt }).text)
      return commit(...args)
    }
    await expect(makeProjectFromIdea(idea, draft())).rejects.toMatchObject({ status: 409, code: 'idea_changed' })
    expect(commits(repo)).toHaveLength(1)
    expect(JSON.parse(repo.text(`ideas/${ID1}.json`)!).text).toBe('Другое')
    expect(repo.text(draft().path)).toBeUndefined()
  })

  it('идею удалили в другом месте — 404 без коммита', async () => {
    const repo = await start([ideaFile(ID2)])
    await expect(makeProjectFromIdea(idea, draft())).rejects.toMatchObject({ status: 404 })
    expect(repo.log).toEqual([])
  })

  it('не 409 — ошибка наверх, без повтора', async () => {
    const repo = await start([source()])
    repo.hooks.failCommit = [new ApiError(422, 'validation', 'схема')]
    await expect(makeProjectFromIdea(idea, draft())).rejects.toMatchObject({ status: 422 })
    expect(repo.log.filter((l) => l.startsWith('commit'))).toHaveLength(1)
  })
})

describe('удаление проекта', () => {
  const project = (path: string) => (JSON.parse(onScreen(path)!.text) as { project?: string }).project
  const idN = (i: number) => `01J8Z6Y000000000000000${String(i).padStart(4, '0')}`

  it('проект, обложка и отвязка его идей — одним коммитом; чужие идеи и незнакомые поля целы', async () => {
    const cover = { path: 'covers/a.webp', sha: 'sha-cover', text: '' }
    const repo = await start([projectFile('a'), cover, ideaFile(ID1, { project: 'a', mood: 'x' }), ideaFile(ID2, { project: 'b' }), ideaFile(ID3)])
    await deleteProject('a')
    expect(commits(repo)).toEqual([`commit h0 projects/a.json,covers/a.webp,ideas/${ID1}.json`])
    expect(repo.text('projects/a.json')).toBeUndefined()
    const unlinked = JSON.parse(repo.text(`ideas/${ID1}.json`)!)
    expect(unlinked.project).toBeUndefined()
    expect(unlinked.mood).toBe('x')
    expect(JSON.parse(repo.text(`ideas/${ID2}.json`)!).project).toBe('b')
    expect(onScreen('projects/a.json')).toBeUndefined()
    expect(project(`ideas/${ID1}.json`)).toBeUndefined()
    expect(useSession.getState().tree?.head).toBe('h2')
    const cached = await getCachedFiles('main')
    expect(JSON.parse(cached.find((f) => f.path === `ideas/${ID1}.json`)!.text).project).toBeUndefined()
  })

  it('без идей — прежний коммит только с файлами проекта', async () => {
    const repo = await start([projectFile('a'), ideaFile(ID1)])
    await deleteProject('a')
    expect(commits(repo)).toEqual(['commit h0 projects/a.json'])
  })

  it('ветку сдвинули и привязали ещё идею — отвязка считается заново, одна повторная попытка', async () => {
    const repo = await start([projectFile('a'), ideaFile(ID1, { project: 'a' })])
    repo.external(`ideas/${ID2}.json`, ideaFile(ID2, { project: 'a' }).text)
    await deleteProject('a')
    expect(commits(repo)).toEqual([`commit h0 projects/a.json,ideas/${ID1}.json`, `commit h2 projects/a.json,ideas/${ID1}.json,ideas/${ID2}.json`])
    expect(JSON.parse(repo.text(`ideas/${ID2}.json`)!).project).toBeUndefined()
    expect(repo.text('projects/a.json')).toBeUndefined()
  })

  it('два конфликта подряд — ошибка, ничего не записано', async () => {
    const repo = await start([projectFile('a'), ideaFile(ID1, { project: 'a' })])
    repo.hooks.failCommit = [new ApiError(409, 'conflict', 'x'), new ApiError(409, 'conflict', 'x')]
    await expect(deleteProject('a')).rejects.toMatchObject({ status: 409 })
    expect(commits(repo)).toHaveLength(2)
    expect(repo.text('projects/a.json')).toBeDefined()
    expect(JSON.parse(repo.text(`ideas/${ID1}.json`)!).project).toBe('a')
  })

  it('граница: удаление и 99 идей — ровно 100 файлов, одним коммитом', async () => {
    const ideas = Array.from({ length: 99 }, (_, i) => ideaFile(idN(i + 1), { project: 'a' }))
    const repo = await start([projectFile('a'), ...ideas])
    await deleteProject('a')
    const log = commits(repo)
    expect(log).toHaveLength(1)
    expect(log[0]!.split(' ')[2]!.split(',')).toHaveLength(100)
    for (const f of ideas) expect(JSON.parse(repo.text(f.path)!).project).toBeUndefined()
    expect(repo.text('projects/a.json')).toBeUndefined()
  })

  it('идей больше лимита коммита: удаление и 99 идей первым коммитом, остаток — следующим', async () => {
    const ideas = Array.from({ length: 105 }, (_, i) => ideaFile(idN(i + 1), { project: 'a' }))
    const repo = await start([projectFile('a'), ...ideas])
    await deleteProject('a')
    const log = commits(repo)
    expect(log).toHaveLength(2)
    expect(log[0]!.split(' ')[2]!.split(',')).toHaveLength(100)
    expect(log[0]).toContain('commit h0 projects/a.json,')
    expect(log[1]!.split(' ')[2]!.split(',')).toHaveLength(6)
    expect(log[1]).toMatch(/^commit h\d+ ideas\//)
    for (const f of ideas) {
      expect(JSON.parse(repo.text(f.path)!).project).toBeUndefined()
      expect(project(f.path)).toBeUndefined()
    }
    expect(repo.text('projects/a.json')).toBeUndefined()
  })

  it('повтор после обрыва: проект уже удалён, идеи ещё привязаны — коммит только с отвязкой', async () => {
    const repo = await start([ideaFile(ID1, { project: 'a' })])
    await deleteProject('a')
    expect(commits(repo)).toEqual([`commit h0 ideas/${ID1}.json`])
    await deleteProject('a')
    expect(commits(repo)).toHaveLength(1)
  })

  it('идея новее сборки не трогается, проект удаляется', async () => {
    const repo = await start([projectFile('a'), ideaFile(ID1, { project: 'a', schemaVersion: 9 })])
    await deleteProject('a')
    expect(commits(repo)).toEqual(['commit h0 projects/a.json'])
  })
})

const puts = (repo: { log: string[] }, path: string) => repo.log.filter((l) => l === `put ${path}`).length

describe('идеи через очередь правок (ADR-004)', () => {
  const draftOf = (text: string, id = ID1) => {
    const d = newIdeaDraft(text, new Date('2026-09-23T14:32:00+03:00'), id)
    if (!d.ok) throw new Error(d.error)
    return d
  }

  it('без сети: идея сразу на экране и в очереди, индикатор её считает; появилась сеть — записана один раз', async () => {
    const repo = await start([])
    const d = draftOf('В метро')
    repo.hooks.down = true
    await createIdea(d)
    expect(onScreen(d.path)?.text).toBe(d.text)
    expect(buildInbox(useSession.getState().files).ideas.map((i) => i.title)).toEqual(['В метро'])
    expect(useSession.getState().queued).toBe(1)
    expect(await getQueue()).toMatchObject([{ kind: 'idea', path: d.path, baseSha: '', baseText: d.text, text: d.text }])
    expect(repo.text(d.path)).toBeUndefined()
    repo.hooks.down = false
    await useSession.getState().syncNow()
    expect(repo.text(d.path)).toBe(d.text)
    expect(puts(repo, d.path)).toBe(1)
    expect(useSession.getState().queued).toBe(0)
    expect(await getQueue()).toEqual([])
    expect(onScreen(d.path)).toMatchObject({ text: d.text })
    expect(onScreen(d.path)!.sha).not.toBe('')
  })

  it('идея без сети переживает перезапуск и уходит после него', async () => {
    const repo = await start([])
    const d = draftOf('Не потерять')
    repo.hooks.down = true
    await createIdea(d)
    resetQueueMemory()
    useSession.setState({ phase: 'booting', files: [] })
    await useSession.getState().boot()
    expect(onScreen(d.path)?.text).toBe(d.text)
    repo.hooks.down = false
    await useSession.getState().syncNow()
    expect(repo.text(d.path)).toBe(d.text)
    expect(await getQueue()).toEqual([])
  })

  it('повтор после потерянного ответа не создаёт дубль: одна идея, очередь пуста', async () => {
    const repo = await start([])
    const d = draftOf('Один раз')
    repo.hooks.lose = true
    await createIdea(d)
    expect(useSession.getState().queued).toBe(1)
    await useSession.getState().flush()
    expect(repo.text(d.path)).toBe(d.text)
    expect((await useSession.getState().remote.listFiles('main')).files.filter((f) => f.path.startsWith('ideas/'))).toHaveLength(1)
    expect(await getQueue()).toEqual([])
    // Тот же черновик ещё раз (двойное нажатие) — ничего нового.
    await createIdea(d)
    expect(puts(repo, d.path)).toBe(2)
  })

  it('ответ потерялся, а идею успели поправить на другом устройстве — не конфликт: чужая правка цела, записи нет', async () => {
    const repo = await start([])
    const d = draftOf('Моя')
    repo.hooks.lose = true
    await createIdea(d)
    repo.external(d.path, JSON.stringify({ ...JSON.parse(d.text), project: 'hub' }))
    await useSession.getState().flush()
    expect(JSON.parse(repo.text(d.path)!)).toMatchObject({ text: 'Моя', project: 'hub' })
    expect(await getConflicts()).toEqual([])
    expect(await getQueue()).toEqual([])
    expect(puts(repo, d.path)).toBe(2)
  })

  it('без сети текст поменяли и вернули — правка ничего не меняет: в репо не пишется', async () => {
    const repo = await start([ideaFile(ID1)])
    repo.hooks.down = true
    await saveIdea(ID1, { text: 'Другое' })
    expect(useSession.getState().queued).toBe(1)
    await saveIdea(ID1, { text: 'Идея 1' })
    // Писать нечего — правка уходит из очереди сразу, даже без сети.
    expect(repo.log).toEqual([])
    expect(useSession.getState().queued).toBe(0)
    expect(await getQueue()).toEqual([])
  })

  it('правка новой идеи до отправки — одна запись с последним текстом', async () => {
    const repo = await start([])
    const d = draftOf('Черновик')
    repo.hooks.down = true
    await createIdea(d)
    await saveIdea(ID1, { text: 'Чистовик' })
    await saveIdea(ID1, { project: 'hub' })
    expect(useSession.getState().queued).toBe(1)
    expect(JSON.parse(onScreen(d.path)!.text)).toMatchObject({ text: 'Чистовик', project: 'hub' })
    repo.hooks.down = false
    await useSession.getState().flush()
    expect(puts(repo, d.path)).toBe(1)
    expect(JSON.parse(repo.text(d.path)!)).toMatchObject({ id: ID1, text: 'Чистовик', project: 'hub', createdAt: JSON.parse(d.text).createdAt })
  })

  it('в репо уже другая идея с тем же именем — не затираем: моя версия во «Входящих»', async () => {
    const other = ideaFile(ID1, { text: 'Чужая' })
    const repo = await start([])
    const d = draftOf('Моя')
    repo.hooks.down = true
    await createIdea(d)
    repo.external(other.path, other.text)
    repo.hooks.down = false
    await useSession.getState().flush()
    expect(repo.text(d.path)).toBe(other.text)
    const [c] = await getConflicts()
    expect(c).toMatchObject({ path: d.path, title: 'Моя', refused: { mine: d.text } })
    expect(await getQueue()).toEqual([])
  })

  it('без сети правка идеи в очереди; сеть есть, в репо поменяли другое поле — слито, одна запись', async () => {
    const repo = await start([ideaFile(ID1)])
    const path = `ideas/${ID1}.json`
    repo.hooks.down = true
    await saveIdea(ID1, { text: 'Мой текст' })
    expect(JSON.parse(onScreen(path)!.text).text).toBe('Мой текст')
    expect(await getQueue()).toMatchObject([{ kind: 'idea', patch: { text: 'Мой текст' } }])
    repo.external(path, JSON.stringify({ ...JSON.parse(repo.text(path)!), project: 'hub' }))
    repo.hooks.down = false
    await useSession.getState().flush()
    expect(JSON.parse(repo.text(path)!)).toMatchObject({ text: 'Мой текст', project: 'hub' })
    expect(await getConflicts()).toEqual([])
  })

  it('идею удалили в репо, а у меня правка — конфликт «идея удалена», «моя» возвращает её', async () => {
    const repo = await start([ideaFile(ID1)])
    const path = `ideas/${ID1}.json`
    repo.hooks.down = true
    await saveIdea(ID1, { text: 'Моя правка' })
    repo.hooks.down = false
    await useSession.getState().remote.commit('main', [{ path, text: null }], (await useSession.getState().remote.listFiles('main')).head, 'удалить')
    await useSession.getState().flush()
    const [c] = await getConflicts()
    expect(c).toMatchObject({ path, title: 'Моя правка', deleted: {} })
    await useSession.getState().resolveConflict('main', path, [{ index: 0, pick: 'mine' }])
    expect(JSON.parse(repo.text(path)!).text).toBe('Моя правка')
    expect(await getConflicts()).toEqual([])
  })

  it('удалить идею, которая ещё не ушла в репо, — убрать из очереди; в репо ничего не пишется', async () => {
    const repo = await start([])
    const d = draftOf('Передумал')
    repo.hooks.down = true
    await createIdea(d)
    // Без сети из репо не удалить: пользователь узнаёт, что удалено только с устройства.
    await expect(deleteIdea(ID1)).rejects.toThrow(DELETED_ONLY_ON_DEVICE)
    expect(onScreen(d.path)).toBeUndefined()
    expect(useSession.getState().queued).toBe(0)
    expect(await getQueue()).toEqual([])
    repo.hooks.down = false
    await useSession.getState().syncNow()
    expect(repo.log).toEqual([])
  })

  it('сверка перед удалением упала (502) — по старому дереву не удаляем: ошибка, идея из репо остаётся видна', async () => {
    const repo = await start([])
    const d = draftOf('Дошла, а сверка упала')
    repo.hooks.lose = true
    await createIdea(d)
    expect(repo.text(d.path)).toBe(d.text)
    expect(useSession.getState().tree?.paths).not.toContain(d.path) // старое дерево: идеи в нём нет
    repo.hooks.failList = new ApiError(502, 'upstream', 'GitHub не ответил')
    const err = await deleteIdea(ID1).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(ideaErrorText(err, 'идея не удалена')).toBe(DELETED_ONLY_ON_DEVICE)
    expect(commits(repo)).toEqual([])
    repo.hooks.failList = undefined
    await useSession.getState().syncNow()
    expect(repo.text(d.path)).toBe(d.text)
    expect(onScreen(d.path)?.text).toBe(d.text) // не пропала молча — её можно удалить ещё раз
    await deleteIdea(ID1)
    expect(repo.text(d.path)).toBeUndefined()
  })

  it('удалить идею, пока её создание летит на сервер, — дождаться ответа и удалить из репо: идея не воскресает', async () => {
    const repo = await start([])
    const d = draftOf('Передумал на лету')
    const put = repo.remote.putFile
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const inFlight = new Promise<void>((r) => (started = r))
    repo.remote.putFile = async (...a) => {
      started()
      await gate
      return put(...a)
    }
    const creating = createIdea(d)
    await inFlight
    const deleting = deleteIdea(ID1)
    // Удаление успевает дойти до конца, если не ждёт ответа на создание: даём ему время, потом сервер отвечает.
    await new Promise((r) => setTimeout(r, 30))
    release()
    await creating
    await deleting
    expect(repo.text(d.path)).toBeUndefined()
    expect(onScreen(d.path)).toBeUndefined()
    await useSession.getState().syncNow()
    expect(onScreen(d.path)).toBeUndefined()
    expect(await getQueue()).toEqual([])
  })

  it('создание дошло, ответ потерялся, идея ещё в очереди — удаление при сети удаляет её и из репо', async () => {
    const repo = await start([])
    const d = draftOf('Дошла молча')
    repo.hooks.lose = true
    await createIdea(d)
    expect(useSession.getState().queued).toBe(1)
    expect(repo.text(d.path)).toBe(d.text)
    await deleteIdea(ID1)
    expect(repo.text(d.path)).toBeUndefined()
    expect(onScreen(d.path)).toBeUndefined()
    expect(useSession.getState().queued).toBe(0)
    await useSession.getState().syncNow()
    expect(repo.text(d.path)).toBeUndefined()
    expect(onScreen(d.path)).toBeUndefined()
  })

  it('«Сделать проектом» из идеи с неотправленной правкой — без сети отказ, идея цела', async () => {
    const repo = await start([ideaFile(ID1)])
    repo.hooks.down = true
    await saveIdea(ID1, { text: 'Правка' })
    const idea = JSON.parse(onScreen(`ideas/${ID1}.json`)!.text) as Idea
    const d = projectFromIdeaDraft(idea, { title: 'Правка', status: 'active', nextStep: '' }, [])
    if (!d.ok) throw new Error(d.error)
    await expect(makeProjectFromIdea(idea, d)).rejects.toMatchObject({ status: 0 })
    expect(commits(repo)).toEqual([])
    expect(useSession.getState().queued).toBe(1)
  })
})
