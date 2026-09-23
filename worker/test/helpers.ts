// Тестовое окружение Worker: настоящий SQLite (node:sqlite) под интерфейсом D1 и настоящая миграция.
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { generateKeyPairSync } from 'node:crypto'
import type { Env } from '../env'
import { OAUTH_COOKIE } from '../authGithub'
import { handle, type Deps } from '../index'
import { SESSION_COOKIE } from '../sessions'

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly args: SQLInputValue[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args as SQLInputValue[])
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[], success: true }
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args)
    return { success: true, meta: { changes: Number(r.changes) } }
  }
  runSync() {
    this.db.prepare(this.sql).run(...this.args)
  }
}

export function fakeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'))
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN')
      try {
        for (const s of stmts) s.runSync()
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return stmts.map(() => ({ success: true }))
    },
  }
  return { d1: d1 as unknown as D1Database, sql: db }
}

export const ORIGIN = 'https://hub.tartaluga.workers.dev'
export const OWNER_ID = 123869746

let keys: { pkcs1: string; pkcs8: string; publicPem: string } | null = null
export function testKeys() {
  keys ??= (() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    return {
      pkcs1: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
      pkcs8: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    }
  })()
  return keys
}

export function testEnv(overrides: Partial<Env> = {}) {
  const { d1, sql } = fakeD1()
  const assets: Request[] = []
  const env: Env = {
    ASSETS: { fetch: async (r: Request) => (assets.push(r), new Response('static')) } as unknown as Fetcher,
    DB: d1,
    APP_ORIGIN: ORIGIN,
    GITHUB_APP_ID: '1',
    GITHUB_APP_CLIENT_ID: 'Iv-test',
    GITHUB_INSTALLATION_ID: '42',
    OWNER_GITHUB_ID: String(OWNER_ID),
    DATA_OWNER: 'tartaluga',
    DATA_REPO: 'tartaluga-hub-data',
    GITHUB_APP_PRIVATE_KEY: testKeys().pkcs1,
    GITHUB_APP_CLIENT_SECRET: 'client-secret',
    COOKIE_SECRET: 'cookie-secret-for-tests-0123456789abcdef',
    ...overrides,
  }
  return { env, sql, assets }
}

/** Мок fetch: по очереди отдаёт ответы из обработчика и запоминает запросы. */
export function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { fn, calls }
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Значение cookie из Set-Cookie ответа. */
export function cookieFrom(res: Response, name: string): string | undefined {
  for (const c of res.headers.getSetCookie()) {
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(';')[0]
  }
  return undefined
}

// ---------- Сценарии запросов к серверу ----------

export type Call = { method: string; url: string; body: any }
export type Handler = (c: Call) => Response | undefined | Promise<Response | undefined>

/** GitHub: вход и токен установки отвечают всегда, остальное — обработчики теста. Необработанный запрос — ошибка теста. */
export function github(...handlers: Handler[]) {
  const calls: Call[] = []
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    if (c.url === 'https://github.com/login/oauth/access_token') return jsonResponse({ access_token: 'user-token' })
    if (c.url === 'https://api.github.com/user') return jsonResponse({ id: OWNER_ID })
    if (c.url.includes('/applications/')) return new Response(null, { status: 204 })
    if (c.url.endsWith('/access_tokens'))
      return jsonResponse({ token: 'inst', expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: [{ name: 'tartaluga-hub-data' }] }, 201)
    for (const h of handlers) {
      const r = await h(c)
      if (r) return r
    }
    throw new Error(`unexpected ${c.method} ${c.url}`)
  }) as typeof fetch
  const repoCalls = () => calls.filter((c) => c.url.includes('/repos/'))
  return { fn, calls, repoCalls }
}

export const on =
  (method: string, part: string, res: (c: Call) => Response): Handler =>
  (c) =>
    c.method === method && c.url.includes(part) ? res(c) : undefined

export async function session(env: ReturnType<typeof testEnv>['env'], fn: typeof fetch, now = Date.now()) {
  const deps: Deps = { fetch: fn, now: () => now }
  const start = await handle(new Request(`${ORIGIN}/api/auth/github/start`), env, deps)
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!
  const cb = await handle(
    new Request(`${ORIGIN}/api/auth/github/callback?code=x&state=${state}`, { headers: { Cookie: `${OAUTH_COOKIE}=${cookieFrom(start, OAUTH_COOKIE)}` } }),
    env,
    deps,
  )
  return `${SESSION_COOKIE}=${cookieFrom(cb, SESSION_COOKIE)}`
}

/** Изменяющий запрос как из хаба: наш Origin, X-Hub, JSON. */
export function mutation(method: string, path: string, cookie: string, body?: unknown, extra: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, 'X-Hub': '1', 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

export async function setup(...handlers: Handler[]) {
  const { env, sql } = testEnv()
  const gh = github(...handlers)
  const cookie = await session(env, gh.fn)
  gh.calls.length = 0
  const send = (r: Request, now?: number) => handle(r, env, { fetch: gh.fn, now: () => now ?? Date.now() })
  return { env, sql, gh, cookie, send }
}

