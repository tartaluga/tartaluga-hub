import { describe, expect, it } from 'vitest'
import { GitHubClient, GitHubError } from './github'
import { decodeText, encodeText } from './base64'

type Call = { method: string; url: string; init: RequestInit; body: any }
type Reply = { status: number; json?: unknown; headers?: Record<string, string> }
type Route = (call: Call) => Reply | undefined | Promise<Reply | undefined>

/** Поддельный fetch: маршруты проверяются по порядку, первый ответивший побеждает. */
function fakeFetch(...routes: Route[]) {
  const calls: Call[] = []
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: String(input),
      init,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    for (const r of routes) {
      const reply = await r(call)
      if (reply) {
        return new Response(reply.status === 204 ? null : JSON.stringify(reply.json ?? {}), {
          status: reply.status,
          headers: { 'content-type': 'application/json', ...reply.headers },
        })
      }
    }
    throw new Error(`Нет маршрута для ${call.method} ${call.url}`)
  }) as typeof fetch
  return { fn, calls }
}

const on =
  (method: string, pathPart: string, reply: Reply | ((c: Call) => Reply)): Route =>
  (c) =>
    c.method === method && c.url.includes(pathPart) ? (typeof reply === 'function' ? reply(c) : reply) : undefined

const client = (fetchFn: typeof fetch) => new GitHubClient({ token: 'tkn', owner: 'o', repo: 'r', fetch: fetchFn })

describe('GitHubClient: запросы', () => {
  it('шлёт токен, версию API и no-store', async () => {
    const f = fakeFetch(on('GET', '/repos/o/r', { status: 200, json: {} }))
    await client(f.fn).checkAccess()
    const c = f.calls[0]!
    // Без слеша в конце — иначе браузер блокирует запрос на CORS-preflight (проверено вживую).
    expect(c.url).toBe('https://api.github.com/repos/o/r')
    expect(c.init.cache).toBe('no-store')
    expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer tkn')
    expect((c.init.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it.each([
    [401, {}, 'unauthorized'],
    [403, {}, 'forbidden'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'],
    [429, {}, 'rate_limited'],
    [404, {}, 'not_found'],
    [409, {}, 'conflict'],
    [502, {}, 'server'],
  ] as const)('HTTP %i → %s', async (status, headers, kind) => {
    const f = fakeFetch(() => ({ status, headers, json: { message: 'x' } }))
    await expect(client(f.fn).checkAccess()).rejects.toMatchObject({ kind })
  })

  it('обрыв сети → network', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(client(failing).checkAccess()).rejects.toMatchObject({ kind: 'network' })
  })

  it('путь с пробелом и кириллицей кодируется по сегментам', async () => {
    const f = fakeFetch(on('GET', '/contents/', { status: 404 }))
    await client(f.fn).readFile('projects/мой проект.json')
    expect(f.calls[0]!.url).toContain('/contents/projects/%D0%BC%D0%BE%D0%B9%20%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82.json?ref=main')
  })
})

describe('GitHubClient: чтение', () => {
  it('listFiles: берёт дерево именно того коммита, который вернул', async () => {
    const f = fakeFetch(
      on('GET', '/git/ref/heads/main', { status: 200, json: { object: { sha: 'HEAD1' } } }),
      on('GET', '/git/trees/HEAD1', {
        status: 200,
        json: {
          truncated: false,
          tree: [
            { path: 'projects', type: 'tree', sha: 't' },
            { path: 'projects/a.json', type: 'blob', sha: 'b1', size: 10 },
          ],
        },
      }),
    )
    expect(await client(f.fn).listFiles()).toEqual({ commitSha: 'HEAD1', files: [{ path: 'projects/a.json', sha: 'b1', size: 10 }] })
  })

  it('readFile: кириллица декодируется, отсутствующий файл → null', async () => {
    const f = fakeFetch(
      on('GET', '/contents/a.json', { status: 200, json: { sha: 's1', encoding: 'base64', content: encodeText('{"t":"Привет"}') } }),
      on('GET', '/contents/none.json', { status: 404, json: { message: 'Not Found' } }),
    )
    const c = client(f.fn)
    expect(await c.readFile('a.json')).toEqual({ text: '{"t":"Привет"}', sha: 's1' })
    expect(await c.readFile('none.json')).toBeNull()
  })

  it('readFile: файл больше 1 МБ (без content) дочитывается через blob', async () => {
    const f = fakeFetch(
      on('GET', '/contents/big.json', { status: 200, json: { sha: 'big', encoding: 'none', content: '' } }),
      on('GET', '/git/blobs/big', { status: 200, json: { encoding: 'base64', content: encodeText('большой') } }),
    )
    expect(await client(f.fn).readFile('big.json')).toEqual({ text: 'большой', sha: 'big' })
  })
})

describe('GitHubClient: запись', () => {
  it('updateFile: отправляет sha и кириллицу в base64', async () => {
    const f = fakeFetch(on('PUT', '/contents/p.json', { status: 200, json: { content: { sha: 'new' } } }))
    const res = await client(f.fn).updateFile('p.json', 'Задача ✓', 'old', 'правка')
    expect(res).toEqual({ text: 'Задача ✓', sha: 'new' })
    const body = f.calls[0]!.body
    expect(body.sha).toBe('old')
    expect(body.branch).toBe('main')
    expect(decodeText(body.content)).toBe('Задача ✓')
  })

  it('updateFile: устаревший sha → conflict', async () => {
    const f = fakeFetch(on('PUT', '/contents/', { status: 409, json: { message: 'p.json does not match old' } }))
    await expect(client(f.fn).updateFile('p.json', 'x', 'old', 'm')).rejects.toMatchObject({ kind: 'conflict' })
  })

  it('createFile: новый файл создаётся без sha', async () => {
    const f = fakeFetch(on('PUT', '/contents/', { status: 201, json: { content: { sha: 'c1' } } }))
    await client(f.fn).createFile('ideas/X.json', '{}', 'идея')
    expect(f.calls[0]!.body.sha).toBeUndefined()
  })

  it('createFile: повтор после потерянного ответа — успех, если содержимое то же', async () => {
    const f = fakeFetch(
      on('PUT', '/contents/', { status: 422, json: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } }),
      on('GET', '/contents/ideas/X.json', { status: 200, json: { sha: 'was', encoding: 'base64', content: encodeText('{"a":1}') } }),
    )
    expect(await client(f.fn).createFile('ideas/X.json', '{"a":1}', 'идея')).toEqual({ text: '{"a":1}', sha: 'was' })
  })

  it('createFile: файл есть с другим содержимым → already_exists, без перезаписи', async () => {
    const f = fakeFetch(
      on('PUT', '/contents/', { status: 422, json: { message: '"sha" wasn\'t supplied.' } }),
      on('GET', '/contents/', { status: 200, json: { sha: 'other', encoding: 'base64', content: encodeText('{"a":2}') } }),
    )
    await expect(client(f.fn).createFile('projects/x.json', '{"a":1}', 'm')).rejects.toMatchObject({ kind: 'already_exists' })
    expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('записи идут строго по одной, даже если вызваны одновременно', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const f = fakeFetch(async (c) => {
      if (c.method !== 'PUT') return undefined
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { status: 200, json: { content: { sha: 's' } } }
    })
    const c = client(f.fn)
    await Promise.all([c.updateFile('a', '1', 's', 'm'), c.updateFile('b', '2', 's', 'm'), c.createFile('c', '3', 'm')])
    expect(maxInFlight).toBe(1)
  })

  it('ошибка одной записи не блокирует следующие', async () => {
    let n = 0
    const f = fakeFetch(on('PUT', '/contents/', () => (++n === 1 ? { status: 500 } : { status: 200, json: { content: { sha: 'ok' } } })))
    const c = client(f.fn)
    const [first, second] = await Promise.allSettled([c.updateFile('a', '1', 's', 'm'), c.updateFile('b', '2', 's', 'm')])
    expect(first.status).toBe('rejected')
    expect(second).toMatchObject({ status: 'fulfilled', value: { sha: 'ok' } })
  })
})

describe('GitHubClient: атомарный коммит', () => {
  const gitRoutes = (refReply: Reply = { status: 200, json: {} }) => {
    let blobN = 0
    return fakeFetch(
      on('GET', '/git/ref/heads/main', { status: 200, json: { object: { sha: 'HEAD' } } }),
      on('GET', '/git/commits/HEAD', { status: 200, json: { tree: { sha: 'TREE0' } } }),
      on('POST', '/git/blobs', () => ({ status: 201, json: { sha: `BLOB${++blobN}` } })),
      on('POST', '/git/trees', { status: 201, json: { sha: 'TREE1' } }),
      on('POST', '/git/commits', { status: 201, json: { sha: 'C1' } }),
      on('PATCH', '/git/refs/heads/main', refReply),
    )
  }

  it('текст — прямо в дереве, blob только для бинарного → tree → commit → ветка без force', async () => {
    const f = gitRoutes()
    const res = await client(f.fn).commitFiles(
      [
        { path: 'projects/x.json', content: '{"title":"Икс"}' },
        { path: 'covers/x.webp', content: new Uint8Array([1, 2, 3]) },
        { path: 'ideas/OLD.json', content: null },
      ],
      'Сделать проектом',
    )
    // sha текста — как у git: printf '{"title":"Икс"}' | git hash-object --stdin
    expect(res).toEqual({ commitSha: 'C1', shas: { 'projects/x.json': '8f13f3e5cf65684144c532cb40600ea47a193f63', 'covers/x.webp': 'BLOB1' } })
    expect(f.calls.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(1)

    const tree = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/trees'))!.body
    expect(tree.base_tree).toBe('TREE0')
    expect(tree.tree).toEqual([
      { path: 'projects/x.json', mode: '100644', type: 'blob', content: '{"title":"Икс"}' },
      { path: 'covers/x.webp', mode: '100644', type: 'blob', sha: 'BLOB1' },
      { path: 'ideas/OLD.json', mode: '100644', type: 'blob', sha: null },
    ])

    const commit = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))!.body
    expect(commit.parents).toEqual(['HEAD'])

    const ref = f.calls.find((c) => c.method === 'PATCH')!.body
    expect(ref).toEqual({ sha: 'C1', force: false })
  })

  it('ветку сдвинули во время коммита → conflict', async () => {
    const f = gitRoutes({ status: 422, json: { message: 'Update is not a fast forward' } })
    await expect(client(f.fn).commitFiles([{ path: 'a', content: 'x' }], 'm')).rejects.toMatchObject({ kind: 'conflict' })
  })

  it('expectedHead не совпал → conflict, ничего не создаётся', async () => {
    const f = gitRoutes()
    await expect(client(f.fn).commitFiles([{ path: 'a', content: 'x' }], 'm', 'OLDHEAD')).rejects.toBeInstanceOf(GitHubError)
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})
