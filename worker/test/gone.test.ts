// ADR-014: «нет ветки» и «нет файла» — только подтверждённые. 404 GitHub при невидимом репо — временная ошибка.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetGitHubAppCaches } from '../githubApp'
import { UPSTREAM_UNAVAILABLE_TEXT } from '../gone'
import { jsonResponse, mutation, on, ORIGIN, setup, type Handler } from './helpers'

const PROJECT = readFileSync(new URL('../../schema/examples/valid/project-full.json', import.meta.url), 'utf8') // slug tartaluga-hub
const PATH = 'projects/tartaluga-hub.json'
const REPO = 'https://api.github.com/repos/tartaluga/tartaluga-hub-data'
const HEAD = 'c'.repeat(40)
const SHA = 'a'.repeat(40)

const notFound = () => jsonResponse({ message: 'Not Found' }, 404)

/** GET самого репо (checkAccess): видно, не видно (404) или GitHub сбоит. */
const repo =
  (state: 'visible' | 'hidden' | 'down'): Handler =>
  (c) => {
    if (c.method !== 'GET' || c.url !== REPO) return undefined
    if (state === 'visible') return jsonResponse({ full_name: 'tartaluga/tartaluga-hub-data' })
    return state === 'hidden' ? notFound() : jsonResponse({ message: 'Server Error' }, 502)
  }

const branch = (name: string, exists: boolean): Handler =>
  on('GET', `/git/ref/heads/${name}`, () => (exists ? jsonResponse({ object: { sha: HEAD } }) : notFound()))
const file = (exists: boolean): Handler =>
  on('GET', `/contents/${PATH}`, () => (exists ? jsonResponse({ sha: SHA, encoding: 'none', content: '' }) : notFound()))

const get = (path: string, cookie: string) => new Request(ORIGIN + path, { headers: { Cookie: cookie } })

async function outcome(res: Response) {
  return { status: res.status, code: ((await res.json()) as { error?: { code: string } }).error?.code }
}

const UNAVAILABLE = { status: 503, code: 'upstream_unavailable' }

beforeEach(() => resetGitHubAppCaches())

describe('GET /api/files: нет ветки', () => {
  it('ветки нет, репо видно — 404 branch_not_found, репо проверено после ветки', async () => {
    const { gh, cookie, send } = await setup(branch('feat', false), repo('visible'))
    expect(await outcome(await send(get('/api/files?branch=feat', cookie)))).toEqual({ status: 404, code: 'branch_not_found' })
    // Запрос ветки, её перепроверка и проверка репо — последней: пропавший между запросами доступ не станет «удалено».
    expect(gh.repoCalls().map((c) => c.url.replace(REPO, ''))).toEqual(['/git/ref/heads/feat', '/git/ref/heads/feat', ''])
  })

  it.each(['hidden', 'down'] as const)('404 ветки, а репо %s — 503 upstream_unavailable, не «удалено»', async (state) => {
    const { cookie, send } = await setup(branch('feat', false), repo(state))
    expect(await outcome(await send(get('/api/files?branch=feat', cookie)))).toEqual(UNAVAILABLE)
  })

  it('404, а при перепроверке ветка есть — 503 (ответ GitHub не объяснён)', async () => {
    let n = 0
    const { cookie, send } = await setup(
      on('GET', '/git/ref/heads/feat', () => (++n === 1 ? notFound() : jsonResponse({ object: { sha: HEAD } }))),
      repo('visible'),
    )
    expect(await outcome(await send(get('/api/files?branch=feat', cookie)))).toEqual(UNAVAILABLE)
  })

  it('перепроверка ветки упёрлась в лимит GitHub — 503, а не «удалено»', async () => {
    let n = 0
    const { cookie, send } = await setup(
      on('GET', '/git/ref/heads/feat', () =>
        ++n === 1 ? notFound() : new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      ),
      repo('visible'),
    )
    expect(await outcome(await send(get('/api/files?branch=feat', cookie)))).toEqual(UNAVAILABLE)
  })

  it('дерево ответило 404 при живой ветке — 503', async () => {
    const { cookie, send } = await setup(branch('feat', true), on('GET', '/git/trees/', notFound), repo('visible'))
    expect(await outcome(await send(get('/api/files?branch=feat', cookie)))).toEqual(UNAVAILABLE)
  })
})

describe('PUT /api/file: нет файла', () => {
  const put404 = on('PUT', `/contents/${PATH}`, notFound)
  const update = (cookie: string) => mutation('PUT', '/api/file', cookie, { branch: 'draft', path: PATH, text: PROJECT, sha: SHA })

  it('ветка есть, файла нет, репо видно — 404 not_found; не больше трёх доп. запросов', async () => {
    const { gh, cookie, send } = await setup(put404, branch('draft', true), file(false), repo('visible'))
    expect(await outcome(await send(update(cookie)))).toEqual({ status: 404, code: 'not_found' })
    expect(gh.repoCalls()).toHaveLength(1 + 3)
  })

  it.each(['hidden', 'down'] as const)('файла нет, а репо %s — 503', async (state) => {
    const { cookie, send } = await setup(put404, branch('draft', true), file(false), repo(state))
    expect(await outcome(await send(update(cookie)))).toEqual(UNAVAILABLE)
  })

  it('файл есть, а запись ответила 404 — 503, не «удалено»', async () => {
    const { cookie, send } = await setup(put404, branch('draft', true), file(true), repo('visible'))
    expect(await outcome(await send(update(cookie)))).toEqual(UNAVAILABLE)
  })

  it('ветки нет — 404 branch_not_found; репо не видно — 503', async () => {
    const a = await setup(put404, branch('draft', false), repo('visible'))
    expect(await outcome(await a.send(update(a.cookie)))).toEqual({ status: 404, code: 'branch_not_found' })
    const b = await setup(put404, branch('draft', false), repo('hidden'))
    expect(await outcome(await b.send(update(b.cookie)))).toEqual(UNAVAILABLE)
  })

  it('создание (без sha) с 404 при живой ветке — 503: создание не может «потерять» файл', async () => {
    const { gh, cookie, send } = await setup(put404, branch('draft', true), file(false), repo('visible'))
    const res = await send(mutation('PUT', '/api/file', cookie, { branch: 'draft', path: PATH, text: PROJECT }))
    expect(await outcome(res)).toEqual(UNAVAILABLE)
    expect(gh.repoCalls().some((c) => c.method === 'GET' && c.url.includes('/contents/'))).toBe(false)
  })

  it('422 «does not exist» от GitHub тоже проверяется, а не отдаётся как «удалено»', async () => {
    const { cookie, send } = await setup(
      on('PUT', `/contents/${PATH}`, () => jsonResponse({ message: 'Branch draft does not exist' }, 422)),
      branch('draft', true),
      file(true),
      repo('visible'),
    )
    expect(await outcome(await send(update(cookie)))).toEqual(UNAVAILABLE)
  })
})

describe('прочие команды к репо данных', () => {
  it('коммит в ветку, которой нет — branch_not_found; при невидимом репо — 503', async () => {
    const req = (cookie: string) =>
      mutation('POST', '/api/commit', cookie, { branch: 'draft', expectedHead: HEAD, changes: [{ path: PATH, text: PROJECT }] })
    const a = await setup(branch('draft', false), repo('visible'))
    expect(await outcome(await a.send(req(a.cookie)))).toEqual({ status: 404, code: 'branch_not_found' })
    const b = await setup(branch('draft', false), repo('hidden'))
    expect(await outcome(await b.send(req(b.cookie)))).toEqual(UNAVAILABLE)
  })

  it('слияние ветки, которой нет — branch_not_found', async () => {
    const { cookie, send } = await setup(branch('draft', false), repo('visible'))
    expect(await outcome(await send(mutation('POST', '/api/branches/draft/merge', cookie)))).toEqual({ status: 404, code: 'branch_not_found' })
  })

  it('удаление ветки, которой уже нет (подтверждено) — успех; не подтверждено — 503', async () => {
    const del422 = on('DELETE', '/git/refs/heads/draft', () => jsonResponse({ message: 'Reference does not exist' }, 422))
    const a = await setup(del422, branch('draft', false), repo('visible'))
    const res = await a.send(mutation('DELETE', '/api/branches/draft', a.cookie))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, alreadyGone: true })
    const b = await setup(del422, branch('draft', false), repo('hidden'))
    expect(await outcome(await b.send(mutation('DELETE', '/api/branches/draft', b.cookie)))).toEqual(UNAVAILABLE)
  })

  it('текст 503 не обещает автоповтор — его видят и действия без очереди', async () => {
    const { cookie, send } = await setup(on('GET', '/branches', notFound))
    const res = await send(get('/api/branches', cookie))
    expect((await res.json()).error.message).toBe(UPSTREAM_UNAVAILABLE_TEXT)
    expect(UPSTREAM_UNAVAILABLE_TEXT).not.toMatch(/повторю/)
  })

  it('blob: репо видно — not_found; не видно — 503', async () => {
    const a = await setup(on('GET', '/git/blobs/', notFound), repo('visible'))
    expect(await outcome(await a.send(get(`/api/blob/${SHA}`, a.cookie)))).toEqual({ status: 404, code: 'not_found' })
    const b = await setup(on('GET', '/git/blobs/', notFound), repo('hidden'))
    expect(await outcome(await b.send(get(`/api/blob/${SHA}`, b.cookie)))).toEqual(UNAVAILABLE)
  })

  it('404 GitHub, который обработчик не проверял (список веток) — 503, не not_found', async () => {
    const { cookie, send } = await setup(on('GET', '/branches', notFound))
    expect(await outcome(await send(get('/api/branches', cookie)))).toEqual(UNAVAILABLE)
  })

  it('виджеты: status.json нет при видимом репо — not_found; репо не видно — 503', async () => {
    const a = await setup(on('GET', '/contents/status.json', notFound), repo('visible'))
    expect(await outcome(await a.send(get('/api/status', a.cookie)))).toEqual({ status: 404, code: 'not_found' })
    const b = await setup(on('GET', '/contents/status.json', notFound), repo('hidden'))
    expect(await outcome(await b.send(get('/api/status', b.cookie)))).toEqual(UNAVAILABLE)
    const c = await setup(on('POST', '/dispatches', notFound), repo('hidden'))
    expect(await outcome(await c.send(mutation('POST', '/api/status/refresh', c.cookie)))).toEqual(UNAVAILABLE)
  })
})

describe('неизвестная команда', () => {
  it('404 no_route, не not_found — и GitHub не спрашивается', async () => {
    const { gh, cookie, send } = await setup()
    expect(await outcome(await send(get('/api/nope', cookie)))).toEqual({ status: 404, code: 'no_route' })
    expect(await outcome(await send(mutation('POST', '/api/files/extra', cookie, {})))).toEqual({ status: 404, code: 'no_route' })
    expect(gh.repoCalls()).toEqual([])
  })
})
