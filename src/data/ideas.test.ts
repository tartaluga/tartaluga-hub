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
  filterIdeas,
  firstLine,
  makeProjectFromIdea,
  newIdeaDraft,
  projectFromIdeaDraft,
  rebaseIdeaPatch,
  saveIdea,
  shortDate,
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

describe('сделать проектом', () => {
  const idea: Idea = { schemaVersion: 1, id: ID1, text: 'Бот расписания', createdAt: '2026-09-20T10:00:00+03:00' }
  const draft = () => {
    const d = projectFromIdeaDraft(idea, { title: 'Бот расписания', status: 'active', nextStep: '' }, [])
    if (!d.ok) throw new Error(d.error)
    return d
  }

  it('проект и удаление идеи одним коммитом; на экране сразу проект без идеи', async () => {
    const repo = await start([ideaFile(ID1, { text: idea.text, createdAt: idea.createdAt })])
    const d = draft()
    await makeProjectFromIdea(ID1, d)
    expect(repo.log.filter((l) => l.startsWith('commit'))).toEqual([`commit h0 ${d.path},ideas/${ID1}.json`])
    expect(JSON.parse(repo.text(d.path)!).fromIdea.ideaId).toBe(ID1)
    expect(repo.text(`ideas/${ID1}.json`)).toBeUndefined()
    expect(onScreen(d.path)?.text).toBe(d.text)
    expect(onScreen(`ideas/${ID1}.json`)).toBeUndefined()
  })

  it('ветку сдвинули — одна повторная попытка от свежего дерева', async () => {
    const repo = await start([ideaFile(ID1)])
    repo.external('ideas/' + ID2 + '.json', ideaFile(ID2).text)
    await makeProjectFromIdea(ID1, draft())
    expect(repo.log.filter((l) => l.startsWith('commit'))).toHaveLength(2)
    expect(repo.text(`ideas/${ID1}.json`)).toBeUndefined()
  })

  it('повтор после обрыва: проект уже создан тем же черновиком — успех без второго коммита', async () => {
    const repo = await start([ideaFile(ID1)])
    const d = draft()
    await makeProjectFromIdea(ID1, d)
    await makeProjectFromIdea(ID1, d)
    expect(repo.log.filter((l) => l.startsWith('commit'))).toHaveLength(1)
  })

  it('slug занят другим проектом — отказ без коммита', async () => {
    const d = draft()
    const repo = await start([ideaFile(ID1), { path: d.path, sha: 'other', text: projectFile(d.slug).text }])
    await expect(makeProjectFromIdea(ID1, d)).rejects.toMatchObject({ status: 409, code: 'slug_taken' })
    expect(repo.log).toEqual([])
    expect(repo.text(`ideas/${ID1}.json`)).toBeDefined()
  })

  it('идею удалили в другом месте — 404 без коммита', async () => {
    const repo = await start([ideaFile(ID2)])
    await expect(makeProjectFromIdea(ID1, draft())).rejects.toMatchObject({ status: 404 })
    expect(repo.log).toEqual([])
  })

  it('не 409 — ошибка наверх, без повтора', async () => {
    const repo = await start([ideaFile(ID1)])
    repo.hooks.failCommit = [new ApiError(422, 'validation', 'схема')]
    await expect(makeProjectFromIdea(ID1, draft())).rejects.toMatchObject({ status: 422 })
    expect(repo.log.filter((l) => l.startsWith('commit'))).toHaveLength(1)
  })
})
