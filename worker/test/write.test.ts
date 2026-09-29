import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetGitHubAppCaches } from '../githubApp'
import { COMMIT_BODY_LIMIT, COMMIT_IMAGE_LIMIT, COMMIT_LIMIT } from '../write'
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
    ['две задачи с одним id', { path: 'projects/tartaluga-hub.json', text: PROJECT.replace('"id": "01K5TQ0000000000000000C002"', '"id": "01K5TQ0000000000000000C001"') }, 422],
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
    const out = await res.json()
    expect(out.head).toBe('f'.repeat(40))
    // sha текста считается как у git (blob <длина>\0<байты>) — без запроса к GitHub.
    const gitSha = createHash('sha1').update(`blob ${Buffer.byteLength(PROJECT)}\0`).update(PROJECT).digest('hex')
    expect(out.shas).toEqual({ 'projects/tartaluga-hub.json': gitSha, 'covers/tartaluga-hub.webp': SHA })
    expect(gh.repoCalls().filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(1)
    const tree = gh.repoCalls().find((c) => c.url.endsWith('/git/trees'))!.body.tree
    expect(tree[0]).toEqual({ path: 'projects/tartaluga-hub.json', mode: '100644', type: 'blob', content: PROJECT })
    expect(tree.map((t: { path: string; sha?: string | null }) => [t.path, t.sha])).toEqual([
      ['projects/tartaluga-hub.json', undefined],
      ['covers/tartaluga-hub.webp', SHA],
      ['ideas/01K5TQ0000000000000000E001.json', null],
    ])
    expect(gh.repoCalls().find((c) => c.method === 'PATCH')!.body).toEqual({ sha: 'f'.repeat(40), force: false })
    expect(gh.repoCalls().find((c) => c.url.endsWith('/git/commits') && c.method === 'POST')!.body.message).toBe('Идея → проект')
  })

  it('граница: 100 файлов — 99 проектов по ~40 КБ и обложка 2 МБ — одним коммитом', { timeout: 30_000 }, async () => {
    expect(COMMIT_LIMIT).toBe(100)
    const { gh, cookie, send } = await setup(...gitData)
    const padded = (slug: string) => {
      const p = JSON.parse(PROJECT)
      return JSON.stringify({ ...p, slug, description: 'Описание проекта. '.repeat(1250) }, null, 2)
    }
    const cover = Buffer.concat([WEBP, Buffer.alloc(2 * 1024 * 1024 - WEBP.length)])
    const changes = [
      ...Array.from({ length: 99 }, (_, i) => ({ path: `projects/p${i}.json`, text: padded(`p${i}`) })),
      { path: 'covers/p0.webp', base64: cover.toString('base64') },
    ]
    const body = JSON.stringify({ expectedHead: HEAD, changes })
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(6 * 1024 * 1024)
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(COMMIT_BODY_LIMIT)
    const res = await send(mutation('POST', '/api/commit', cookie, { expectedHead: HEAD, changes }))
    expect(res.status).toBe(200)
    expect(gh.repoCalls().find((c) => c.url.endsWith('/git/trees'))!.body.tree).toHaveLength(100)
  })

  it('подзапросы к GitHub не растут с числом текстовых файлов: 100 файлов — не больше 10 (лимит Workers Free — 50)', async () => {
    const { gh, cookie, send } = await setup(...gitData)
    const changes = Array.from({ length: COMMIT_LIMIT }, (_, i) => ({ path: `projects/p${i}.json`, text: JSON.stringify({ ...JSON.parse(PROJECT), slug: `p${i}` }) }))
    const res = await send(mutation('POST', '/api/commit', cookie, { expectedHead: HEAD, changes }))
    expect(res.status).toBe(200)
    expect(Object.keys((await res.json()).shas)).toHaveLength(COMMIT_LIMIT)
    expect(gh.calls.length).toBeLessThanOrEqual(10)
    expect(gh.calls.filter((c) => c.url.endsWith('/git/blobs'))).toEqual([])
  })

  it(`картинок больше ${COMMIT_IMAGE_LIMIT} — 413 с понятной ошибкой, в GitHub ничего не пишется`, async () => {
    expect(COMMIT_IMAGE_LIMIT + 10).toBeLessThan(45)
    const { gh, cookie, send } = await setup(...gitData)
    const covers = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `covers/p${i}.webp`, base64: WEBP.toString('base64') }))
    const res = await send(mutation('POST', '/api/commit', cookie, { expectedHead: HEAD, changes: covers(COMMIT_IMAGE_LIMIT + 1) }))
    expect(res.status).toBe(413)
    expect((await res.json()).error.message).toContain(`${COMMIT_IMAGE_LIMIT} картинок`)
    expect(gh.repoCalls().filter((c) => c.method !== 'GET')).toEqual([])

    const ok = await send(mutation('POST', '/api/commit', cookie, { expectedHead: HEAD, changes: covers(COMMIT_IMAGE_LIMIT) }))
    expect(ok.status).toBe(200)
    expect(gh.calls.length).toBeLessThan(45)
  })

  it('тело коммита больше лимита — 413, в GitHub ничего не пишется', async () => {
    const { gh, cookie, send } = await setup(...gitData)
    const changes = [{ path: 'projects/p0.json', text: 'x'.repeat(COMMIT_BODY_LIMIT) }]
    expect((await send(mutation('POST', '/api/commit', cookie, { expectedHead: HEAD, changes }))).status).toBe(413)
    expect(gh.repoCalls().filter((c) => c.method !== 'GET')).toEqual([])
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
    ['больше 100 файлов', { expectedHead: HEAD, changes: Array.from({ length: 101 }, (_, i) => ({ path: `projects/p${i}.json`, text: null })) }, 413],
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

  describe('удаление тега: settings.json и несколько проектов одним коммитом', () => {
    const project = (slug: string, tags: string[]) => JSON.stringify({ ...JSON.parse(PROJECT), slug, tags }, null, 2) + '\n'
    const untag = (extra: object[] = []) => ({
      expectedHead: HEAD,
      message: 'Хаб: удалить тег web',
      changes: [
        { path: 'settings.json', text: example('settings.json') },
        { path: 'projects/a.json', text: project('a', []) },
        { path: 'projects/b.json', text: project('b', ['hw']) },
        ...extra,
      ],
    })

    it('успех: без отдельных блобов для текста, одно дерево, один коммит, ref без force', async () => {
      const { gh, cookie, send } = await setup(...gitData)
      const res = await send(mutation('POST', '/api/commit', cookie, untag()))
      expect(res.status).toBe(200)
      expect(Object.keys((await res.json()).shas)).toEqual(['settings.json', 'projects/a.json', 'projects/b.json'])
      const posts = gh.repoCalls().filter((c) => c.method === 'POST')
      expect(posts.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(0)
      expect(posts.filter((c) => c.url.endsWith('/git/trees'))).toHaveLength(1)
      expect(posts.filter((c) => c.url.endsWith('/git/commits'))).toHaveLength(1)
      expect(gh.repoCalls().filter((c) => c.method === 'PATCH')).toHaveLength(1)
    })

    it('ветку сдвинули между шагами (GitHub: не fast forward) — 409, ветка не сдвинута', async () => {
      const refusal = on('PATCH', '/git/refs/heads/main', () => jsonResponse({ message: 'Update is not a fast forward' }, 422))
      const { gh, cookie, send } = await setup(refusal, ...gitData)
      const res = await send(mutation('POST', '/api/commit', cookie, untag()))
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('conflict')
      expect(gh.repoCalls().filter((c) => c.method === 'PATCH')).toHaveLength(1)
    })

    it.each([
      ['один проект не проходит схему', [{ path: 'projects/c.json', text: JSON.stringify({ schemaVersion: 2, slug: 'c' }) }], 422],
      ['один путь вне правил', [{ path: 'README.md', text: 'x' }], 400],
      ['путь с обходом каталога', [{ path: 'projects/../.github/x.json', text: '{}' }], 400],
    ])('%s → %i, ничего не пишется', async (_name, extra, status) => {
      const { gh, cookie, send } = await setup(...gitData)
      expect((await send(mutation('POST', '/api/commit', cookie, untag(extra)))).status).toBe(status)
      expect(gh.repoCalls().filter((c) => c.method !== 'GET')).toEqual([])
    })
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
  const MERGED = 'f'.repeat(40)
  const mergeOk = on('POST', '/merges', () => jsonResponse({ sha: MERGED }, 201))
  const mainHead = on('GET', '/git/ref/heads/main', () => jsonResponse({ object: { sha: HEAD } }))
  /** Итог слияния: что изменилось в main между прежней головой и коммитом слияния. */
  const merged = (files: object[]) => on('GET', `/compare/${HEAD}...${MERGED}`, () => jsonResponse({ ahead_by: 2, files }))
  const blobBy = (sha: string, text: string) =>
    on('GET', `/git/blobs/${sha}`, () => jsonResponse({ encoding: 'base64', content: Buffer.from(text).toString('base64') }))

  it('проверенные файлы вливаются; вливается именно проверенный коммит', async () => {
    const file = { filename: 'projects/tartaluga-hub.json', status: 'modified', sha: SHA }
    const { gh, cookie, send } = await setup(branchHead, mainHead, compare([file]), blob(PROJECT), mergeOk, merged([file]))
    const res = await send(mutation('POST', '/api/branches/draft/merge', cookie))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ merged: true, head: MERGED })
    expect(gh.repoCalls().find((c) => c.url.endsWith('/merges'))!.body).toMatchObject({ base: 'main', head: BRANCH_HEAD })
    // Итог совпал с проверенным в ветке — повторно не читается.
    expect(gh.repoCalls().filter((c) => c.url.includes('/git/blobs/'))).toHaveLength(1)
  })

  it('итог слияния проверяется: склейка с main дала неверный файл — 200 с предупреждением, main не откатывается', async () => {
    const MIXED = 'd'.repeat(40)
    const OTHER = 'e'.repeat(40)
    const broken = JSON.stringify({ ...JSON.parse(PROJECT), status: 'нет-такого' })
    const { gh, cookie, send } = await setup(
      branchHead,
      mainHead,
      compare([{ filename: 'projects/tartaluga-hub.json', status: 'modified', sha: SHA }]),
      blobBy(SHA, PROJECT),
      blobBy(MIXED, broken),
      blobBy(OTHER, example('settings.json')),
      mergeOk,
      merged([
        { filename: 'projects/tartaluga-hub.json', status: 'modified', sha: MIXED },
        { filename: 'settings.json', status: 'modified', sha: OTHER },
        { filename: 'ideas/01K5TQ0000000000000000E001.json', status: 'removed', sha: SHA },
        { filename: 'covers/x.webp', status: 'added', sha: SHA },
      ]),
    )
    const res = await send(mutation('POST', '/api/branches/draft/merge', cookie))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.merged).toBe(true)
    expect(body.head).toBe(MERGED)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0].path).toBe('projects/tartaluga-hub.json')
    expect(body.warnings[0].error).toEqual(expect.any(String))
    expect(gh.repoCalls().some((c) => c.method === 'PATCH' || c.method === 'DELETE')).toBe(false)
  })

  it('файл, не изменённый при слиянии относительно проверенного в ветке, повторно не читается; изменённый — читается', async () => {
    const MIXED = 'd'.repeat(40)
    const OTHER = 'e'.repeat(40)
    const same = { filename: 'projects/tartaluga-hub.json', status: 'modified', sha: SHA }
    const { gh, cookie, send } = await setup(
      branchHead,
      mainHead,
      compare([same, { filename: 'settings.json', status: 'modified', sha: OTHER }]),
      blobBy(SHA, PROJECT),
      blobBy(OTHER, example('settings.json')),
      blobBy(MIXED, example('settings.json')),
      mergeOk,
      merged([same, { filename: 'settings.json', status: 'modified', sha: MIXED }]),
    )
    const res = await send(mutation('POST', '/api/branches/draft/merge', cookie))
    expect(res.status).toBe(200)
    const reads = gh.repoCalls().filter((c) => c.url.includes('/git/blobs/')).map((c) => c.url.split('/').pop())
    expect(reads).toHaveLength(3)
    expect(reads.filter((s) => s === SHA)).toHaveLength(1)
    expect(reads).toContain(MIXED)
  })

  it('сбой проверки итога — всё равно 200 и checkFailed (слияние уже в main)', async () => {
    const file = { filename: 'projects/tartaluga-hub.json', status: 'modified', sha: SHA }
    const { cookie, send } = await setup(
      branchHead,
      mainHead,
      compare([file]),
      blob(PROJECT),
      mergeOk,
      on('GET', `/compare/${HEAD}...${MERGED}`, () => jsonResponse({ message: 'boom' }, 500)),
    )
    const res = await send(mutation('POST', '/api/branches/draft/merge', cookie))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ merged: true, head: MERGED, checkFailed: true })
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
      mainHead,
      merged([]),
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

    const conflict = await setup(branchHead, mainHead, compare([{ filename: 'covers/x.jpg', status: 'added', sha: SHA }]), on('POST', '/merges', () => jsonResponse({ message: 'Merge conflict' }, 409)))
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
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Number.isNaN(Date.parse(body.at))).toBe(false)
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(gh.repoCalls()[0]!.body).toEqual({ ref: 'main' })
  })

  it('workflow ещё нет — понятный 404', async () => {
    const repoVisible: Handler = (c) => (c.method === 'GET' && c.url.endsWith('/repos/tartaluga/tartaluga-hub-data') ? jsonResponse({}) : undefined)
    const { cookie, send } = await setup(on('POST', '/dispatches', () => jsonResponse({ message: 'Not Found' }, 404)), repoVisible)
    const res = await send(mutation('POST', '/api/status/refresh', cookie))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatchObject({ code: 'not_found', message: 'Проверка виджетов не настроена' })
  })

  it('422 (в status.yml нет workflow_dispatch) — тоже «не настроено», но только при видимом репо', async () => {
    const repoVisible: Handler = (c) => (c.method === 'GET' && c.url.endsWith('/repos/tartaluga/tartaluga-hub-data') ? jsonResponse({}) : undefined)
    const unprocessable = () => jsonResponse({ message: "Workflow does not have 'workflow_dispatch' trigger" }, 422)
    const a = await setup(on('POST', '/dispatches', unprocessable), repoVisible)
    const res = await a.send(mutation('POST', '/api/status/refresh', a.cookie))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatchObject({ code: 'not_found', message: 'Проверка виджетов не настроена' })
    const repoHidden: Handler = (c) => (c.method === 'GET' && c.url.endsWith('/repos/tartaluga/tartaluga-hub-data') ? jsonResponse({ message: 'Not Found' }, 404) : undefined)
    const b = await setup(on('POST', '/dispatches', unprocessable), repoHidden)
    expect((await b.send(mutation('POST', '/api/status/refresh', b.cookie))).status).toBe(503)
  })

  it('403 и 5xx GitHub — 503 upstream_unavailable, без «не настроено»', async () => {
    for (const status of [403, 500, 502]) {
      const { cookie, send } = await setup(on('POST', '/dispatches', () => jsonResponse({ message: 'nope' }, status)))
      const res = await send(mutation('POST', '/api/status/refresh', cookie))
      expect(res.status).toBe(503)
      expect((await res.json()).error.code).toBe('upstream_unavailable')
    }
  })

  it('лимит GitHub — 429, а не 503', async () => {
    const limited = () => new Response(JSON.stringify({ message: 'rate' }), { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    const { cookie, send } = await setup(on('POST', '/dispatches', limited))
    expect((await send(mutation('POST', '/api/status/refresh', cookie))).status).toBe(429)
  })

  it('без сессии и с чужого origin GitHub не вызывается; GET — 405', async () => {
    const { gh, cookie, send } = await setup(on('POST', '/dispatches', () => new Response(null, { status: 204 })))
    expect((await send(mutation('POST', '/api/status/refresh', ''))).status).toBe(401)
    expect((await send(mutation('POST', '/api/status/refresh', cookie, undefined, { Origin: 'https://evil.example' }))).status).toBe(403)
    expect((await send(new Request(`${ORIGIN}/api/status/refresh`, { headers: { Cookie: cookie } }))).status).toBe(405)
    expect(gh.repoCalls()).toEqual([])
  })
})
