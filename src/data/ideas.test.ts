import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSession, type Remote } from '../app/session'
import { ApiError, type Me } from '../lib/api'
import { getCachedFiles, wipeDevice } from '../lib/localdb'
import type { Idea } from '../schema/types'
import {
  applyIdeaPatch,
  buildInbox,
  createIdea,
  deleteIdea,
  deleteProject,
  filterIdeas,
  firstLine,
  makeProjectFromIdea,
  newIdeaDraft,
  projectFromIdeaDraft,
  rebaseIdeaPatch,
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

  it('rebaseIdeaPatch: переносит, узнаёт уже сделанное, видит конфликт', () => {
    const base: Idea = { schemaVersion: 1, id: ID1, text: 'A', createdAt: '2026-09-20T10:00:00+03:00' }
    expect(rebaseIdeaPatch(base, { ...base, project: 'x' }, { text: 'B' })).toBe('apply')
    expect(rebaseIdeaPatch(base, { ...base, text: 'B' }, { text: 'B\r\n' })).toBe('already')
    expect(rebaseIdeaPatch(base, { ...base, text: 'C' }, { text: 'B' })).toBe('conflict')
    expect(rebaseIdeaPatch(base, base, { project: null })).toBe('already')
    expect(rebaseIdeaPatch({ ...base, project: 'a' }, { ...base, project: 'b' }, { project: null })).toBe('conflict')
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
  const hooks: { beforePut?: () => void; failCommit?: ApiError[] } = {}
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
      return { head: `h${n}`, files: [...tree] }
    },
    async readBlobText(sha) {
      return blobs[sha]!
    },
    async putFile(_b, path, text, expected) {
      hooks.beforePut?.()
      hooks.beforePut = undefined
      log.push(`put ${path}`)
      const cur = tree.find((f) => f.path === path)
      if (expected !== undefined && cur?.sha !== expected) throw new ApiError(409, 'conflict', 'Файл изменился')
      if (expected === undefined && cur && blobs[cur.sha] !== text) throw new ApiError(409, 'conflict', 'Файл уже есть')
      return { sha: cur && expected === undefined ? cur.sha : write(path, text) }
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

  it('saveIdea: тот же текст поменяли иначе — конфликт, чужая правка цела', async () => {
    const repo = await start([ideaFile(ID1)])
    const path = `ideas/${ID1}.json`
    repo.hooks.beforePut = () => repo.external(path, JSON.stringify({ ...JSON.parse(repo.text(path)!), text: 'Чужой' }))
    await expect(saveIdea(ID1, { text: 'Мой' })).rejects.toMatchObject({ status: 409 })
    expect(JSON.parse(repo.text(path)!).text).toBe('Чужой')
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
