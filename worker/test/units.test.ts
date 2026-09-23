import { createPublicKey, createVerify } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { signValue, verifyValue } from '../crypto'
import { appJwt, installationToken, pemToPkcs8, resetGitHubAppCaches } from '../githubApp'
import { deviceLabel, setCookie } from '../http'
import { assertSha, branchParam, isDataPath, writableBranch } from '../rules'
import { jsonResponse, mockFetch, testEnv, testKeys } from './helpers'

describe('подписанные cookie', () => {
  const secret = 's'.repeat(32)

  it('подпись проходит и возвращает данные', async () => {
    const v = await signValue(secret, 'oauth', { s: 'x' }, 60_000, 1000)
    expect(await verifyValue(secret, 'oauth', v, 2000)).toEqual({ s: 'x' })
  })

  it('подделка, чужой секрет, другое назначение и истёкший срок — отказ', async () => {
    const v = await signValue(secret, 'oauth', { s: 'x' }, 60_000, 1000)
    const [body, sig] = v.split('.')
    const forged = Buffer.from(JSON.stringify({ p: 'oauth', e: 9e15, d: { s: 'evil' } })).toString('base64url')
    expect(await verifyValue(secret, 'oauth', `${forged}.${sig}`, 2000)).toBeNull()
    expect(await verifyValue('other-secret', 'oauth', v, 2000)).toBeNull()
    expect(await verifyValue(secret, 'webauthn', v, 2000)).toBeNull()
    expect(await verifyValue(secret, 'oauth', v, 1000 + 60_001)).toBeNull()
    expect(await verifyValue(secret, 'oauth', `${body}`, 2000)).toBeNull()
    expect(await verifyValue(secret, 'oauth', 'a.b.c', 2000)).toBeNull()
    expect(await verifyValue(secret, 'oauth', undefined, 2000)).toBeNull()
  })
})

describe('ключ и JWT GitHub App', () => {
  beforeEach(() => resetGitHubAppCaches())

  it('PKCS#1 от GitHub переупаковывается в PKCS#8 и совпадает с эталоном', () => {
    const { pkcs1, pkcs8 } = testKeys()
    const expected = Buffer.from(pkcs8.replace(/-----[^-]+-----|\s/g, ''), 'base64')
    expect(Buffer.from(pemToPkcs8(pkcs1))).toEqual(expected)
    expect(Buffer.from(pemToPkcs8(pkcs8))).toEqual(expected)
  })

  it('ключ, вставленный с \\r\\n и пробелами, тоже читается', () => {
    const { pkcs1 } = testKeys()
    const expected = pemToPkcs8(pkcs1)
    expect(pemToPkcs8(`  ${pkcs1.replace(/\n/g, '\r\n')}  `)).toEqual(expected)
    // Поле секрета в панели может склеить строки через пробел или вовсе без разделителя.
    expect(pemToPkcs8(pkcs1.replace(/\n/g, ' '))).toEqual(expected)
    expect(pemToPkcs8(pkcs1.replace(/\n/g, ''))).toEqual(expected)
  })

  it('мусор вместо ключа — понятная ошибка', () => {
    expect(() => pemToPkcs8('not a key')).toThrow(/PEM/)
  })

  it('JWT подписан RS256, iss — Client ID, iat в прошлом, срок меньше 10 минут', async () => {
    const now = Date.UTC(2026, 8, 23, 12)
    const jwt = await appJwt({ GITHUB_APP_CLIENT_ID: 'Iv-test', GITHUB_APP_PRIVATE_KEY: testKeys().pkcs1 }, now)
    const [h, p, s] = jwt.split('.') as [string, string, string]
    const verify = createVerify('RSA-SHA256')
    verify.update(`${h}.${p}`)
    expect(verify.verify(createPublicKey(testKeys().publicPem), Buffer.from(s, 'base64url'))).toBe(true)
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(claims.iss).toBe('Iv-test')
    expect(claims.iat).toBe(now / 1000 - 60)
    expect(claims.exp - now / 1000).toBeLessThan(600)
  })

  it('токен установки: сужен до репо данных, кэшируется, перевыпускается заранее', async () => {
    const { env } = testEnv()
    let n = 0
    const exp = Date.now() + 60 * 60_000
    const { fn, calls } = mockFetch(() => jsonResponse({ token: `t${++n}`, expires_at: new Date(exp).toISOString(), repositories: [{ name: 'tartaluga-hub-data' }] }, 201))

    const [a, b] = await Promise.all([installationToken(env, fn), installationToken(env, fn)])
    expect([a, b]).toEqual(['t1', 't1'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.github.com/app/installations/42/access_tokens')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      repositories: ['tartaluga-hub-data'],
      permissions: { contents: 'write', actions: 'write', metadata: 'read' },
    })
    expect((calls[0]!.init.headers as Record<string, string>)['User-Agent']).toBeTruthy()

    expect(await installationToken(env, fn, exp - 11 * 60_000)).toBe('t1')
    expect(await installationToken(env, fn, exp - 9 * 60_000)).toBe('t2')
  })

  it('токен, видящий не только репо данных, отвергается', async () => {
    const { env } = testEnv()
    const { fn } = mockFetch(() =>
      jsonResponse({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: [{ name: 'tartaluga-hub-data' }, { name: 'other' }] }, 201),
    )
    await expect(installationToken(env, fn)).rejects.toMatchObject({ status: 502 })
  })

  it('ошибка GitHub при выдаче токена — 502 без подробностей', async () => {
    const { env } = testEnv()
    const { fn } = mockFetch(() => jsonResponse({ message: 'A JSON web token could not be decoded' }, 401))
    await expect(installationToken(env, fn)).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('JSON web token') })
  })
})

describe('разрешённые пути и ветки', () => {
  it.each([
    'projects/tartaluga-hub.json',
    'projects/a.json',
    'ideas/01K5TQ0000000000000000E001.json',
    'settings.json',
    'covers/tartaluga-hub.webp',
    'covers/x.jpg',
  ])('можно: %s', (p) => expect(isDataPath(p)).toBe(true))

  it.each([
    '../settings.json',
    'projects/../settings.json',
    'projects/%2e%2e.json',
    '.github/workflows/status.yml',
    'projects/A.json',
    'projects/a--b.json',
    'projects/-a.json',
    'projects/a.json/x',
    'projects/sub/a.json',
    'ideas/lowercase00000000000000000.json',
    'covers/x.svg',
    'covers/x.png',
    'status.json',
    'schema/project.schema.json',
    'README.md',
    'settings.json ',
    '/settings.json',
    `projects/${'a'.repeat(65)}.json`,
  ])('нельзя: %s', (p) => expect(isDataPath(p)).toBe(false))

  it('slug длиной 64 — можно', () => expect(isDataPath(`projects/${'a'.repeat(64)}.json`)).toBe(true))

  it('ветки', () => {
    expect(branchParam(null)).toBe('main')
    expect(branchParam('draft-1')).toBe('draft-1')
    for (const bad of ['Main', 'a/b', '..', '-x', 'a b', 'x'.repeat(41), 'refs/heads/main']) {
      expect(() => branchParam(bad)).toThrow()
    }
    expect(() => writableBranch('status')).toThrow(/только для чтения/)
    expect(() => writableBranch(123)).toThrow()
    expect(writableBranch(undefined)).toBe('main')
  })

  it('sha — ровно 40 hex', () => {
    expect(assertSha('a'.repeat(40))).toBe('a'.repeat(40))
    for (const bad of [undefined, 'A'.repeat(40), 'a'.repeat(39), '../x', 'a'.repeat(64)]) expect(() => assertSha(bad)).toThrow()
  })
})

describe('мелочи http', () => {
  it('cookie только с префиксом __Host- и со всеми флагами', () => {
    expect(setCookie('__Host-x', 'v', { maxAge: 10, sameSite: 'Strict' })).toBe('__Host-x=v; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=10')
    expect(() => setCookie('x', 'v', { maxAge: 10, sameSite: 'Strict' })).toThrow()
  })

  it('устройство — только браузер и ОС', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe('Chrome, Android')
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge, Windows')
    expect(deviceLabel(null)).toBe('неизвестно')
  })
})
