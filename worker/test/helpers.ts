// Тестовое окружение Worker: настоящий SQLite (node:sqlite) под интерфейсом D1 и настоящая миграция.
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { generateKeyPairSync } from 'node:crypto'
import type { Env } from '../env'

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
