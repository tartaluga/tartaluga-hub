import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILD_HEADER, checkBuild, isGuardedWrite, resetBuildCache, serverBuild } from '../build'
import type { Env } from '../env'
import { mutation, ORIGIN, setup, testEnv } from './helpers'

const BUILD = 'a'.repeat(40)

/** Статика деплоя: /build.json с номером сборки, остальное — заглушка. */
function assets(build: unknown = { build: BUILD }, status = 200) {
  const calls: string[] = []
  const fetcher = {
    fetch: async (r: Request) => {
      calls.push(new URL(r.url).pathname)
      if (new URL(r.url).pathname === '/build.json') return new Response(typeof build === 'string' ? build : JSON.stringify(build), { status })
      return new Response('static')
    },
  } as unknown as Fetcher
  return { fetcher, calls }
}

function envWith(fetcher: Fetcher): Env {
  return testEnv({ ASSETS: fetcher }).env
}

beforeEach(() => {
  resetBuildCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('isGuardedWrite: какие запросы проверяют номер сборки', () => {
  it.each([
    ['PUT', '/api/file'],
    ['POST', '/api/commit'],
    ['POST', '/api/branches'],
    ['DELETE', '/api/branches/draft'],
    ['POST', '/api/branches/draft/merge'],
  ])('%s %s — проверяется', (m, p) => expect(isGuardedWrite(m, p)).toBe(true))

  it.each([
    ['GET', '/api/files'],
    ['GET', '/api/branches'],
    ['HEAD', '/api/file'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/logout-all'],
    ['POST', '/api/auth/passkey'],
    ['POST', '/api/passkeys/register'],
    ['POST', '/api/security/seen'],
    ['POST', '/api/status/refresh'],
    ['PUT', '/api/filex'],
  ])('%s %s — не проверяется', (m, p) => expect(isGuardedWrite(m, p)).toBe(false))
})

describe('serverBuild', () => {
  it('читает номер из /build.json статики и запоминает его', async () => {
    const a = assets()
    const env = envWith(a.fetcher)
    expect(await serverBuild(env)).toBe(BUILD)
    expect(await serverBuild(env)).toBe(BUILD)
    expect(a.calls).toEqual(['/build.json'])
  })

  it.each([
    ['нет файла', 'Not found', 404],
    ['не JSON', 'static', 200],
    ['без поля', { other: 1 }, 200],
    ['не строка', { build: 42 }, 200],
    ['мусор в номере', { build: 'a b<script>' }, 200],
  ])('%s — null, и следующий запрос читает заново', async (_n, body, status) => {
    const a = assets(body, status)
    const env = envWith(a.fetcher)
    expect(await serverBuild(env)).toBeNull()
    await serverBuild(env)
    expect(a.calls).toHaveLength(2)
  })
})

describe('checkBuild', () => {
  const write = (build?: string) =>
    new Request(ORIGIN + '/api/file', { method: 'PUT', headers: build === undefined ? {} : { [BUILD_HEADER]: build } })

  it('та же сборка — пропускает', async () => {
    expect(await checkBuild(write(BUILD), '/api/file', envWith(assets().fetcher))).toBeNull()
  })

  it.each([['другая сборка', 'b'.repeat(40)], ['без заголовка', undefined], ['пустой заголовок', '']])('%s — 409 stale_build', async (_n, h) => {
    const res = await checkBuild(write(h), '/api/file', envWith(assets().fetcher))
    expect(res?.status).toBe(409)
    expect(await res!.json()).toMatchObject({ error: { code: 'stale_build' } })
  })

  it('чтение от старой сборки работает', async () => {
    const r = new Request(ORIGIN + '/api/files', { headers: { [BUILD_HEADER]: 'old' } })
    expect(await checkBuild(r, '/api/files', envWith(assets().fetcher))).toBeNull()
  })

  it('без build.json (локальный запуск) — не проверяет', async () => {
    expect(await checkBuild(write('old'), '/api/file', envWith(assets('nope', 404).fetcher))).toBeNull()
  })
})

describe('роутер: запись от старой сборки', () => {
  it('PUT /api/file со старым номером — 409 до обращения к GitHub; выход работает', async () => {
    const { env, gh, cookie, send } = await setup()
    env.ASSETS = assets().fetcher
    const stale = await send(mutation('PUT', '/api/file', cookie, { path: 'projects/x.json', text: '{}' }, { [BUILD_HEADER]: 'old' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'stale_build' } })
    expect(gh.calls).toHaveLength(0)

    const merge = await send(mutation('POST', '/api/branches/draft/merge', cookie, undefined, { [BUILD_HEADER]: 'old' }))
    expect(merge.status).toBe(409)

    const out = await send(mutation('POST', '/api/auth/logout', cookie, undefined, { [BUILD_HEADER]: 'old' }))
    expect(out.status).toBe(200)
  })
})
