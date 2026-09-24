import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetGitHubAppCaches } from '../githubApp'
import { jsonResponse, mutation, on, ORIGIN, setup, type Handler } from './helpers'

const example = (name: string) => readFileSync(new URL(`../../schema/examples/valid/${name}`, import.meta.url), 'utf8')
const PROJECT = example('project-full.json') // slug tartaluga-hub
const HEAD = 'c'.repeat(40)
const BRANCH_HEAD = 'b'.repeat(40)
const SHA = 'a'.repeat(40)

beforeEach(() => resetGitHubAppCaches())

describe('PUT /api/file', () => {
  const putOk = on('PUT', '/contents/projects/tartaluga-hub.json', () => jsonResponse({ content: { sha: SHA } }))

  it('новый файл: без sha, в ту ветку, что просили; незнакомые поля не мешают', async () => {
    const { gh, cookie, send } = await setup(putOk)
    const res = await send(mutation('PUT', '/api/file', cookie, { branch: 'draft', path: 'projects/tartaluga-hub.json', text: PROJECT }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: 'draft', path: 'projects/tartaluga-hub.json', sha: SHA })
    const put = gh.repoCalls()[0]!
    expect(put.body.branch).toBe('draft')
    expect(put.body.sha).toBeUndefined()
    expect(Buffer.from(put.body.content, 'base64').toString('utf8')).toBe(PROJECT)
  })

  it('правка: передаёт ожидаемый sha; устаревший sha — 409 без повтора', async () => {
    let n = 0
    const { gh, cookie, send } = await setup(
      on('PUT', '/contents/', () => (++n, jsonResponse({ message: 'projects/tartaluga-hub.json does not match ' + SHA }, 409))),
    )
    const res = await send(mutation('PUT', '/api/file', cookie, { path: 'projects/tartaluga-hub.json', text: PROJECT, sha: SHA }))
    expect(res.status).toBe(409)
    expect(n).toBe(1)
    expect(gh.repoCalls()[0]!.body.sha).toBe(SHA)
  })

  it.each([
    ['путь вне данных', { path: '.github/workflows/x.yml', text: 'x' }, 400],
    ['обход пути', { path: 'projects/../settings.json', text: PROJECT }, 400],
    ['ветка status', { branch: 'status', path: 'projects/tartaluga-hub.json', text: PROJECT }, 403],
    ['плохая ветка', { branch: 'a/b', path: 'projects/tartaluga-hub.json', text: PROJECT }, 400],
    ['картинка через PUT', { path: 'covers/x.webp', text: 'x' }, 400],
    ['битый JSON', { path: 'projects/tartaluga-hub.json', text: '{ "slug":' }, 422],
    ['нарушение схемы', { path: 'projects/tartaluga-hub.json', text: PROJECT.replace('"active"', '"wip"') }, 422],
    ['slug не совпал с файлом', { path: 'projects/other.json', text: PROJECT }, 422],
    ['версия формата выше нашей', { path: 'projects/tartaluga-hub.json', text: PROJECT.replace('"schemaVersion": 1', '"schemaVersion": 3') }, 422],
    ['элементы без id', { path: 'projects/tartaluga-hub.json', text: PROJECT.replace('"id": "01K5TQ0000000000000000C002", ', '') }, 422],
    ['sha не hex', { path: 'projects/tartaluga-hub.json', text: PROJECT, sha: 'zzz' }, 400],
  ])('%s → %i, в GitHub ничего не пишется', async (_name, body, status) => {
    const { gh, cookie, send } = await setup(putOk)
    const res = await send(mutation('PUT', '/api/file', cookie, body))
    expect(res.status).toBe(status)
    expect(gh.repoCalls().filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('не JSON — 415, слишком большой — 413, чужой Origin — 403', async () => {
    const { cookie, send } = await setup(putOk)
    expect((await send(mutation('PUT', '/api/file', cookie, 'x', { 'Content-Type': 'text/plain' }))).status).toBe(415)
    const huge = JSON.stringify({ path: 'projects/tartaluga-hub.json', text: 'x'.repeat(2 * 1024 * 1024 + 10) })
    expect((await send(mutation('PUT', '/api/file', cookie, huge))).status).toBe(413)
    expect((await send(mutation('PUT', '/api/file', cookie, { path: 'settings.json' }, { Origin: 'https://evil.example' }))).status).toBe(403)
  })
})

describe('POST /api/commit', () => {
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)])
  const gitData: Handler[] = [
    on('GET', '/git/ref/heads/main', () => jsonResponse({ object: { sha: HEAD } })),
    on('GET', `/git/commits/${HEAD}`, () => jsonResponse({ tree: { sha: 't'.repeat(40) } })),
    on('POST', '/git/blobs', () => jsonResponse({ sha: SHA }, 201)),
    on('POST', '/git/trees', () => jsonResponse({ sha: 'e'.repeat(40) }, 201)),
    on('POST', '/git/commits', () => jsonResponse({ sha: 'f'.repeat(40) }, 201)),
    on('PATCH', '/git/refs/heads/main', () => jsonResponse({ object: { sha: 'f'.repeat(40) } })),
  ]

  it('проект + обложка + удаление идеи одним коммитом, от ожидаемого head', async () => {
    const { gh, cookie, send } = await setup(...gitData)
    const res = await send(
      mutation('POST', '/api/commit', cookie, {
        expectedHead: HEAD,
        message: 'Идея → проект',
        changes: [
          { path: 'projects/tartaluga-hub.json', text: PROJECT },
          { path: 'covers/tartaluga-hub.webp', base64: WEBP.toString('base64') },
          { path: 'ideas/01K5TQ0000000000000000E001.json', text: null },
        ],
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).head).toBe('f'.repeat(40))
    const tree = gh.repoCalls().find((c) => c.url.endsWith('/git/trees'))!.body.tree
    expect(tree.map((t: { path: string; sha: string | null }) => [t.path, t.sha])).toEqual([
      ['projects/tartaluga-hub.json', SHA],
      ['covers/tartaluga-hub.webp', SHA],
      ['ideas/01K5TQ0000000000000000E001.json', null],
    ])
    expect(gh.repoCalls().find((c) => c.method === 'PATCH')!.body).toEqual({ sha: 'f'.repeat(40), force: false })
    expect(gh.repoCalls().find((c) => c.url.endsWith('/git/commits') && c.method === 'POST')!.body.message).toBe('Идея → проект')
  })

  it('ветку уже сдвинули — 409, ничего не создано', async () => {
    const { gh, cookie, send } = await setup(...gitData)
    const res = await send(mutation('POST', '/api/commit', cookie, { expectedHead: 'd'.repeat(40), changes: [{ path: 'settings.json', text: example('settings.json') }] }))
    expect(res.status).toBe(409)
    expect(gh.repoCalls().filter((c) => c.method === 'POST')).toEqual([])
  })

  it.each([
    ['без expectedHead', { changes: [{ path: 'settings.json', text: '{}' }] }, 400],
    ['пустой список', { expectedHead: HEAD, changes: [] }, 400],
    ['больше 20 файлов', { expectedHead: HEAD, changes: Array.from({ length: 21 }, (_, i) => ({ path: `projects/p${i}.json`, text: null })) }, 413],
    ['дважды один путь', { expectedHead: HEAD, changes: [{ path: 'settings.json', text: null }, { path: 'settings.json', text: null }] }, 400],
    ['путь вне данных', { expectedHead: HEAD, changes: [{ path: '.github/workflows/status.yml', text: null }] }, 400],
    ['PNG под видом webp', { expectedHead: HEAD, changes: [{ path: 'covers/x.webp', base64: Buffer.from('\x89PNG\r\n\x1a\n00000000').toString('base64') }] }, 422],
    ['JPEG под видом webp', { expectedHead: HEAD, changes: [{ path: 'covers/x.webp', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64') }] }, 422],
    ['невалидный файл', { expectedHead: HEAD, changes: [{ path: 'settings.json', text: '{"schemaVersion":1}' }] }, 422],
    ['ветка status', { branch: 'status', expectedHead: HEAD, changes: [{ path: 'settings.json', text: null }] }, 403],
  ])('%s → %i, в GitHub ничего не пишется', async (_name, body, status) => {
    const { gh, cookie, send } = await setup(...gitData)
    expect((await send(mutation('POST', '/api/commit', cookie, body))).status).toBe(status)
    expect(gh.repoCalls().filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('картинка больше 2 МБ — 413', async () => {
    const { cookie, send } = await setup(...gitData)
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)])
    const res = await send(mutation('POST', '/api/commit', cookie, { expectedHead: HEAD, changes: [{ path: 'covers/x.jpg', base64: big.toString('base64') }] }))
    expect(res.status).toBe(413)
  })
})

describe('ветки', () => {
  it('список: main и status отмечены, ветки со странными именами скрыты', async () => {
    const { cookie, send } = await setup(
      on('GET', '/branches?', () =>
        jsonResponse([
          { name: 'main', commit: { sha: HEAD } },
          { name: 'status', commit: { sha: SHA } },
          { name: 'draft', commit: { sha: BRANCH_HEAD } },
          { name: 'feature/x', commit: { sha: SHA } },
        ]),
      ),
    )
    const res = await send(new Request(`${ORIGIN}/api/branches`, { headers: { Cookie: cookie } }))
    expect((await res.json()).branches).toEqual([
      { name: 'main', head: HEAD, main: true, service: false },
      { name: 'status', head: SHA, main: false, service: true },
      { name: 'draft', head: BRANCH_HEAD, main: false, service: false },
    ])
  })

  it('создание — только от текущего main; уже есть — 409', async () => {
    let exists = false
    const { gh, cookie, send } = await setup(
      on('GET', '/git/ref/heads/main', () => jsonResponse({ object: { sha: HEAD } })),
      on('POST', '/git/refs', () => (exists ? jsonResponse({ message: 'Reference already exists' }, 422) : ((exists = true), jsonResponse({}, 201)))),
    )
    const res = await send(mutation('POST', '/api/branches', cookie, { name: 'draft', from: 'status' }))
    expect(res.status).toBe(201)
    expect(gh.repoCalls().find((c) => c.method === 'POST')!.body).toEqual({ ref: 'refs/heads/draft', sha: HEAD })
    expect((await send(mutation('POST', '/api/branches', cookie, { name: 'draft' }))).status).toBe(409)
  })

  it.each([['main', 403], ['status', 403], ['Draft', 400], ['a/b', 400], ['', 400]])('создать «%s» → %i', async (name, status) => {
    const { gh, cookie, send } = await setup()
    expect((await send(mutation('POST', '/api/branches', cookie, { name }))).status).toBe(status)
    expect(gh.repoCalls()).toEqual([])
  })

  it('удаление — только при свежем входе и не main/status', async () => {
    const { gh, cookie, send } = await setup(on('DELETE', '/git/refs/heads/draft', () => new Response(null, { status: 204 })))
    const later = Date.now() + 6 * 60_000
    const stale = await send(mutation('DELETE', '/api/branches/draft', cookie), later)
    expect(stale.status).toBe(403)
    expect((await stale.json()).error.code).toBe('fresh_login_required')
    expect(gh.repoCalls()).toEqual([])

    expect((await send(mutation('DELETE', '/api/branches/draft', cookie))).status).toBe(200)
    expect((await send(mutation('DELETE', '/api/branches/main', cookie))).status).toBe(403)
    expect((await send(mutation('DELETE', '/api/branches/status', cookie))).status).toBe(403)
    expect((await send(mutation('DELETE', '/api/branches/a%2Fb', cookie))).status).toBe(400)
    // «..» в адресе браузер и URL-парсер сворачивают ещё до сервера: остаётся /api/ — такой команды нет.
    expect((await send(mutation('DELETE', '/api/branches/%2e%2e', cookie))).status).toBe(404)
    expect(gh.repoCalls().filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })
})

describe('слияние ветки в main', () => {
  const compare = (files: object[], aheadBy = 1): Handler =>
    on('GET', `/compare/main...${BRANCH_HEAD}`, () => jsonResponse({ ahead_by: aheadBy, files }))
  const branchHead = on('GET', '/git/ref/heads/draft', () => jsonResponse({ object: { sha: BRANCH_HEAD } }))
  const blob = (text: string) => on('GET', '/git/blobs/', () => jsonResponse({ encoding: 'base64', content: Buffer.from(text).toString('base64') }))
  const mergeOk = on('POST', '/merges', () => jsonResponse({ sha: 'f'.repeat(40) }, 201))

  it('проверенные файлы вливаются; вливается именно проверенный коммит', async () => {
    const { gh, cookie, send } = await setup(branchHead, compare([{ filename: 'projects/tartaluga-hub.json', status: 'modified', sha: SHA }]), blob(PROJECT), mergeOk)
    const res = await send(mutation('POST', '/api/branches/draft/merge', cookie))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ merged: true, head: 'f'.repeat(40) })
    expect(gh.repoCalls().find((c) => c.url.endsWith('/merges'))!.body).toMatchObject({ base: 'main', head: BRANCH_HEAD })
  })

  it('битый файл в ветке — 422 со списком, ничего не вливается', async () => {
    const { gh, cookie, send } = await setup(branchHead, compare([{ filename: 'projects/tartaluga-hub.json', status: 'added', sha: SHA }]), blob('{"broken"'), mergeOk)
    const res = await send(mutation('POST', '/api/branches/draft/merge', cookie))
    expect(res.status).toBe(422)
    expect((await res.json()).error.details.files[0].path).toBe('projects/tartaluga-hub.json')
    expect(gh.repoCalls().some((c) => c.url.endsWith('/merges'))).toBe(false)
  })

  it('файлы вне данных (workflow, переименование из .github) — 422', async () => {
    for (const files of [
      [{ filename: '.github/workflows/status.yml', status: 'modified', sha: SHA }],
      [{ filename: 'projects/x.json', previous_filename: '.github/workflows/status.yml', status: 'renamed', sha: SHA }],
      [{ filename: 'README.md', status: 'modified', sha: SHA }],
    ]) {
      const { gh, cookie, send } = await setup(branchHead, compare(files), mergeOk)
      expect((await send(mutation('POST', '/api/branches/draft/merge', cookie))).status).toBe(422)
      expect(gh.repoCalls().some((c) => c.url.endsWith('/merges'))).toBe(false)
    }
  })

  it('удалённые файлы и обложки не читаются, но вливаются', async () => {
    const { cookie, send } = await setup(
      branchHead,
      compare([
        { filename: 'ideas/01K5TQ0000000000000000E001.json', status: 'removed', sha: SHA },
        { filename: 'covers/x.webp', status: 'added', sha: SHA },
      ]),
      mergeOk,
    )
    expect((await send(mutation('POST', '/api/branches/draft/merge', cookie))).status).toBe(200)
  })

  it('вливать нечего; конфликт — 409; main и status вливать нельзя', async () => {
    const nothing = await setup(branchHead, compare([], 0))
    expect(await (await nothing.send(mutation('POST', '/api/branches/draft/merge', nothing.cookie))).json()).toEqual({ merged: false, reason: 'nothing_to_merge' })

    const conflict = await setup(branchHead, compare([{ filename: 'covers/x.jpg', status: 'added', sha: SHA }]), on('POST', '/merges', () => jsonResponse({ message: 'Merge conflict' }, 409)))
    const res = await conflict.send(mutation('POST', '/api/branches/draft/merge', conflict.cookie))
    expect(res.status).toBe(409)
    expect((await res.json()).error.details.files).toEqual(['covers/x.jpg'])

    const { cookie, send } = await setup()
    expect((await send(mutation('POST', '/api/branches/main/merge', cookie))).status).toBe(403)
    expect((await send(mutation('POST', '/api/branches/status/merge', cookie))).status).toBe(403)
  })
})

describe('обновление виджетов', () => {
  it('запускает status.yml только на main', async () => {
    const { gh, cookie, send } = await setup(on('POST', '/actions/workflows/status.yml/dispatches', () => new Response(null, { status: 204 })))
    const res = await send(mutation('POST', '/api/status/refresh', cookie, { ref: 'draft', inputs: { x: 1 } }))
    expect(res.status).toBe(202)
    expect(gh.repoCalls()[0]!.body).toEqual({ ref: 'main' })
  })

  it('workflow ещё нет — понятный 404', async () => {
    const { cookie, send } = await setup(on('POST', '/dispatches', () => jsonResponse({ message: 'Not Found' }, 404)))
    const res = await send(mutation('POST', '/api/status/refresh', cookie))
    expect(res.status).toBe(404)
    expect((await res.json()).error.message).toBe('Виджеты ещё не настроены')
  })
})
