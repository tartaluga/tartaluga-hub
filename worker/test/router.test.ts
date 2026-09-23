import { beforeEach, describe, expect, it } from 'vitest'
import { OAUTH_COOKIE } from '../authGithub'
import { sha256Hex } from '../crypto'
import { resetGitHubAppCaches } from '../githubApp'
import { handle, type Deps } from '../index'
import { DAY, SESSION_COOKIE } from '../sessions'
import { cookieFrom, jsonResponse, mockFetch, ORIGIN, OWNER_ID, testEnv } from './helpers'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'

/** GitHub: обмен кода, /user, отзыв токена, токен установки и репо данных. */
function github(opts: { userId?: number; tree?: { path: string; type: string; sha: string }[] } = {}) {
  return mockFetch((url, init) => {
    if (url === 'https://github.com/login/oauth/access_token') return jsonResponse({ access_token: 'user-token' })
    if (url === 'https://api.github.com/user') return jsonResponse({ id: opts.userId ?? OWNER_ID, login: 'owner' })
    if (url.startsWith('https://api.github.com/applications/')) return new Response(null, { status: 204 })
    if (url.endsWith('/access_tokens'))
      return jsonResponse({ token: 'inst', expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: [{ name: 'tartaluga-hub-data' }] }, 201)
    if (url.endsWith('/git/ref/heads/main')) return jsonResponse({ object: { sha: 'c'.repeat(40) } })
    if (url.includes('/git/trees/')) return jsonResponse({ truncated: false, tree: opts.tree ?? [] })
    if (url.includes('/git/blobs/')) return jsonResponse({ message: 'Not Found' }, 404)
    throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`)
  })
}

function deps(fetchFn: typeof fetch, now = () => Date.now()): Deps {
  return { fetch: fetchFn, now }
}

const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('Cookie', init.cookie)
  if (!headers.has('User-Agent')) headers.set('User-Agent', UA)
  return new Request(ORIGIN + path, { ...init, headers })
}

/** Полный вход через GitHub; возвращает cookie сессии. */
async function login(env: ReturnType<typeof testEnv>['env'], fetchFn: typeof fetch, extraCookie?: string) {
  const start = await handle(req('/api/auth/github/start'), env, deps(fetchFn))
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!
  const oauth = cookieFrom(start, OAUTH_COOKIE)!
  const cookie = [`${OAUTH_COOKIE}=${oauth}`, extraCookie].filter(Boolean).join('; ')
  const cb = await handle(req(`/api/auth/github/callback?code=abc&state=${state}`, { cookie }), env, deps(fetchFn))
  return { cb, session: cookieFrom(cb, SESSION_COOKIE) }
}

beforeEach(() => resetGitHubAppCaches())

describe('маршрутизация', () => {
  it('не /api — статика', async () => {
    const { env, assets } = testEnv()
    const res = await handle(req('/index.html'), env)
    expect(await res.text()).toBe('static')
    expect(assets).toHaveLength(1)
  })

  it('без сессии всё закрыто: 401 с заголовками API', async () => {
    const { env } = testEnv()
    for (const path of ['/api/me', '/api/files', '/api/status', `/api/blob/${'a'.repeat(40)}`, '/api/nope']) {
      const res = await handle(req(path), env)
      expect(res.status, path).toBe(401)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Type')).toMatch(/^application\/json/)
      expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Нужно войти' } })
    }
  })

  it('изменяющий запрос без X-Hub или с чужим Origin — 403 ещё до проверки сессии', async () => {
    const { env } = testEnv()
    const cases: Record<string, string>[] = [{ Origin: ORIGIN }, { Origin: 'https://evil.example', 'X-Hub': '1' }, { 'X-Hub': '1' }]
    for (const headers of cases) {
      const res = await handle(req('/api/auth/logout', { method: 'POST', headers }), env)
      expect(res.status).toBe(403)
    }
  })

  it('поддельная или битая cookie сессии — 401', async () => {
    const { env } = testEnv()
    for (const cookie of [`${SESSION_COOKIE}=${'A'.repeat(43)}`, `${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=`]) {
      expect((await handle(req('/api/me', { cookie }), env)).status).toBe(401)
    }
  })
})

describe('вход через GitHub', () => {
  it('start: редирект на github.com с state и PKCE, cookie Lax на 5 минут, D1 не трогаем', async () => {
    const { env, sql } = testEnv()
    const res = await handle(req('/api/auth/github/start'), env)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('Location')!)
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(loc.searchParams.get('client_id')).toBe('Iv-test')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/github/callback`)
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const setCookie = res.headers.getSetCookie()[0]!
    expect(setCookie).toMatch(/^__Host-hub_oauth=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/)
    expect(sql.prepare('SELECT count(*) AS n FROM security_log').get()).toEqual({ n: 0 })
  })

  it('владелец входит: сессия Strict, в базе только хэш, токен пользователя отозван, событие в журнале', async () => {
    const { env, sql } = testEnv()
    const { fn, calls } = github()
    const { cb, session } = await login(env, fn)

    expect(cb.status).toBe(302)
    expect(cb.headers.get('Location')).toBe('/')
    const cookies = cb.headers.getSetCookie()
    expect(cookies.some((c) => /^__Host-hub_oauth=; .*Max-Age=0$/.test(c))).toBe(true)
    expect(cookies.find((c) => c.startsWith(SESSION_COOKIE))).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000$/)

    const rows = sql.prepare('SELECT id_hash, auth_method, device FROM sessions').all() as { id_hash: string }[]
    expect(rows).toEqual([{ id_hash: await sha256Hex(session!), auth_method: 'github', device: 'Chrome, Windows' }])
    expect(rows[0]!.id_hash).not.toBe(session)

    const exchange = calls.find((c) => c.url.includes('/login/oauth/access_token'))!
    const body = JSON.parse(exchange.init.body as string)
    expect(body.code).toBe('abc')
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(calls.some((c) => c.url.endsWith('/applications/Iv-test/token') && c.init.method === 'DELETE')).toBe(true)
    expect(sql.prepare('SELECT event, method FROM security_log').all()).toEqual([{ event: 'login', method: 'github' }])

    const me = await handle(req('/api/me', { cookie: `${SESSION_COOKIE}=${session}` }), env, deps(fn))
    expect(me.status).toBe(200)
    expect((await me.json()).session).toMatchObject({ authMethod: 'github', fresh: true, device: 'Chrome, Windows' })
  })

  it('чужой аккаунт GitHub не входит: без сессии, токен всё равно отозван, событие login_denied', async () => {
    const { env, sql } = testEnv()
    const { fn, calls } = github({ userId: 999 })
    const { cb, session } = await login(env, fn)
    expect(cb.headers.get('Location')).toBe('/?auth_error=not_owner')
    expect(session).toBeUndefined()
    expect(sql.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect(sql.prepare('SELECT event FROM security_log').all()).toEqual([{ event: 'login_denied' }])
    expect(calls.some((c) => c.init.method === 'DELETE')).toBe(true)
  })

  it('state не совпал, cookie нет или она чужая — отказ без обращения к GitHub', async () => {
    const { env } = testEnv()
    const { fn, calls } = github()
    const start = await handle(req('/api/auth/github/start'), env)
    const oauth = cookieFrom(start, OAUTH_COOKIE)!
    const bad = [
      req('/api/auth/github/callback?code=abc&state=wrong', { cookie: `${OAUTH_COOKIE}=${oauth}` }),
      req('/api/auth/github/callback?code=abc&state=x'),
      req('/api/auth/github/callback?code=abc&state=x', { cookie: `${OAUTH_COOKIE}=forged.sig` }),
    ]
    for (const r of bad) {
      const res = await handle(r, env, deps(fn))
      expect(res.headers.get('Location')).toBe('/?auth_error=expired')
    }
    expect(calls).toHaveLength(0)
  })

  it('отмена на github.com', async () => {
    const { env } = testEnv()
    const res = await handle(req('/api/auth/github/callback?error=access_denied&state=x'), env)
    expect(res.headers.get('Location')).toBe('/?auth_error=cancelled')
  })

  it('новый вход удаляет прежнюю сессию этого браузера (нет фиксации сессии)', async () => {
    const { env, sql } = testEnv()
    const { fn } = github()
    const first = (await login(env, fn)).session!
    const second = (await login(env, fn, `${SESSION_COOKIE}=${first}`)).session!
    expect(second).not.toBe(first)
    expect(sql.prepare('SELECT id_hash FROM sessions').all()).toEqual([{ id_hash: await sha256Hex(second) }])
  })
})

describe('сессия', () => {
  it('скользящее продление не чаще раза в час и не дальше 90 дней от входа', async () => {
    const { env, sql } = testEnv()
    const { fn } = github()
    const t0 = Date.now()
    const session = (await login(env, fn)).session!
    const cookie = `${SESSION_COOKIE}=${session}`

    const soon = await handle(req('/api/me', { cookie }), env, deps(fn, () => t0 + 30 * 60_000))
    expect(soon.headers.getSetCookie()).toEqual([])

    let t = t0
    for (let i = 0; i < 3; i++) {
      t += 25 * DAY
      const res = await handle(req('/api/me', { cookie }), env, deps(fn, () => t))
      expect(res.status, `через ${(t - t0) / DAY} дней`).toBe(200)
    }
    const row = sql.prepare('SELECT created_at, expires_at FROM sessions').get() as { created_at: number; expires_at: number }
    expect(row.expires_at).toBe(row.created_at + 90 * DAY)
    expect((await handle(req('/api/me', { cookie }), env, deps(fn, () => row.created_at + 90 * DAY + 1))).status).toBe(401)
  })

  it('без обращений 30 дней сессия истекает', async () => {
    const { env } = testEnv()
    const { fn } = github()
    const t0 = Date.now()
    const session = (await login(env, fn)).session!
    const res = await handle(req('/api/me', { cookie: `${SESSION_COOKIE}=${session}` }), env, deps(fn, () => t0 + 30 * DAY + 1000))
    expect(res.status).toBe(401)
  })

  it('свежий вход — 5 минут', async () => {
    const { env } = testEnv()
    const { fn } = github()
    const t0 = Date.now()
    const session = (await login(env, fn)).session!
    const res = await handle(req('/api/me', { cookie: `${SESSION_COOKIE}=${session}` }), env, deps(fn, () => t0 + 6 * 60_000))
    expect((await res.json()).session.fresh).toBe(false)
  })

  it('выход: сессия удалена, cookie стёрта, Clear-Site-Data', async () => {
    const { env, sql } = testEnv()
    const { fn } = github()
    const session = (await login(env, fn)).session!
    const cookie = `${SESSION_COOKIE}=${session}`
    const res = await handle(req('/api/auth/logout', { method: 'POST', cookie, headers: { Origin: ORIGIN, 'X-Hub': '1' } }), env, deps(fn))
    expect(res.status).toBe(200)
    expect(res.headers.get('Clear-Site-Data')).toBe('"cache", "storage"')
    expect(res.headers.getSetCookie()).toContain(`${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`)
    expect(sql.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect((await handle(req('/api/me', { cookie }), env, deps(fn))).status).toBe(401)
  })

  it('GET на logout — 405', async () => {
    const { env } = testEnv()
    const { fn } = github()
    const session = (await login(env, fn)).session!
    expect((await handle(req('/api/auth/logout', { cookie: `${SESSION_COOKIE}=${session}` }), env, deps(fn))).status).toBe(405)
  })
})

describe('чтение данных', () => {
  it('список файлов: только файлы данных, head ветки', async () => {
    const { env } = testEnv()
    const tree = [
      { path: 'settings.json', type: 'blob', sha: '1'.repeat(40) },
      { path: 'projects/hub.json', type: 'blob', sha: '2'.repeat(40) },
      { path: 'projects', type: 'tree', sha: '3'.repeat(40) },
      { path: '.github/workflows/status.yml', type: 'blob', sha: '4'.repeat(40) },
      { path: 'README.md', type: 'blob', sha: '5'.repeat(40) },
    ]
    const { fn, calls } = github({ tree })
    const session = (await login(env, fn)).session!
    const res = await handle(req('/api/files', { cookie: `${SESSION_COOKIE}=${session}` }), env, deps(fn))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.head).toBe('c'.repeat(40))
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(['settings.json', 'projects/hub.json'])
    const ghCall = calls.find((c) => c.url.includes('/git/ref/heads/main'))!
    expect((ghCall.init.headers as Record<string, string>)['User-Agent']).toBe('tartaluga-hub')
  })

  it('неверные параметры — 400; ошибка GitHub — без его текста', async () => {
    const { env } = testEnv()
    const { fn } = github()
    const cookie = `${SESSION_COOKIE}=${(await login(env, fn)).session!}`
    expect((await handle(req('/api/files?branch=../x', { cookie }), env, deps(fn))).status).toBe(400)
    expect((await handle(req('/api/blob/zzz', { cookie }), env, deps(fn))).status).toBe(400)
    const notFound = await handle(req(`/api/blob/${'a'.repeat(40)}`, { cookie }), env, deps(fn))
    expect(notFound.status).toBe(404)
    expect(JSON.stringify(await notFound.json())).not.toContain('Not Found')
  })
})
