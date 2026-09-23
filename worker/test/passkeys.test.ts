import { beforeEach, describe, expect, it } from 'vitest'
import { resetGitHubAppCaches } from '../githubApp'
import { WEBAUTHN_COOKIE } from '../passkeys'
import { SESSION_COOKIE } from '../sessions'
import { SoftAuthenticator } from './authenticator'
import { cookieFrom, mutation, ORIGIN, session, setup } from './helpers'

const RP = 'hub.tartaluga.workers.dev'
const newKey = (o: Partial<ConstructorParameters<typeof SoftAuthenticator>[0]> = {}) => new SoftAuthenticator({ rpId: RP, origin: ORIGIN, ...o })

type Ctx = Awaited<ReturnType<typeof setup>>

/** Регистрация ключа в текущей сессии; возвращает ответ сервера. */
async function registerKey(ctx: Ctx, key: SoftAuthenticator, opts: { cookie?: string; now?: number; name?: string } = {}) {
  const cookie = opts.cookie ?? ctx.cookie
  const optRes = await ctx.send(mutation('POST', '/api/passkeys/register/options', cookie), opts.now)
  if (optRes.status !== 200) return optRes
  const { options } = await optRes.json()
  const challengeCookie = `${WEBAUTHN_COOKIE}=${cookieFrom(optRes, WEBAUTHN_COOKIE)}`
  return ctx.send(mutation('POST', '/api/passkeys/register', `${cookie}; ${challengeCookie}`, { response: key.register(options.challenge), name: opts.name }), opts.now)
}

/** Вход ключом (анонимно или поверх существующей cookie). */
async function loginWith(ctx: Ctx, key: SoftAuthenticator, opts: { cookie?: string; now?: number; tamper?: (r: ReturnType<SoftAuthenticator['login']>) => void } = {}) {
  const optRes = await ctx.send(mutation('POST', '/api/auth/passkey/options', opts.cookie ?? ''), opts.now)
  const { options } = await optRes.json()
  const response = key.login(options.challenge)
  opts.tamper?.(response)
  const cookie = [opts.cookie, `${WEBAUTHN_COOKIE}=${cookieFrom(optRes, WEBAUTHN_COOKIE)}`].filter(Boolean).join('; ')
  return ctx.send(mutation('POST', '/api/auth/passkey', cookie, { response }), opts.now)
}

const count = (ctx: Ctx, sql: string) => (ctx.sql.prepare(sql).get() as { n: number }).n

beforeEach(() => resetGitHubAppCaches())

describe('добавление ключа', () => {
  it('при свежем входе: ключ сохранён, событие в журнале, вызов одноразовый', async () => {
    const ctx = await setup()
    const key = newKey()
    const res = await registerKey(ctx, key, { name: 'Pixel' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: key.id, name: 'Pixel' })
    expect(res.headers.getSetCookie()).toContain(`${WEBAUTHN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`)
    expect(ctx.sql.prepare('SELECT id, name, counter FROM passkeys').all()).toEqual([{ id: key.id, name: 'Pixel', counter: 0 }])
    expect(count(ctx, "SELECT count(*) AS n FROM security_log WHERE event = 'passkey_added'")).toBe(1)
  })

  it('параметры: rpId — точный хост, нужна проверка пользователя, ключ discoverable, уже добавленные исключены', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    const { options } = await (await ctx.send(mutation('POST', '/api/passkeys/register/options', ctx.cookie))).json()
    expect(options.rp).toEqual({ name: 'Tartaluga Hub', id: RP })
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
    expect(options.attestation).toBe('none')
    expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([key.id])
  })

  it('тот же ключ второй раз — 409', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    expect((await registerKey(ctx, key)).status).toBe(409)
  })

  it('без свежего входа — 403 fresh_login_required, ничего не сохраняется', async () => {
    const ctx = await setup()
    const res = await registerKey(ctx, newKey(), { now: Date.now() + 6 * 60_000 })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('fresh_login_required')
    expect(count(ctx, 'SELECT count(*) AS n FROM passkeys')).toBe(0)
  })

  it('вызов, выданный одной сессии, не принимается в другой', async () => {
    const ctx = await setup()
    const optRes = await ctx.send(mutation('POST', '/api/passkeys/register/options', ctx.cookie))
    const { options } = await optRes.json()
    const other = await session(ctx.env, ctx.gh.fn)
    const res = await ctx.send(
      mutation('POST', '/api/passkeys/register', `${other}; ${WEBAUTHN_COOKIE}=${cookieFrom(optRes, WEBAUTHN_COOKIE)}`, { response: newKey().register(options.challenge) }),
    )
    expect(res.status).toBe(400)
  })

  it.each([
    ['без проверки пользователя (UV)', { userVerified: false }],
    ['с чужого адреса', { origin: 'https://evil.example' }],
    ['для другого rpId', { rpId: 'tartaluga.workers.dev' }],
  ])('%s — отказ', async (_n, o) => {
    const ctx = await setup()
    expect((await registerKey(ctx, newKey(o))).status).toBe(400)
    expect(count(ctx, 'SELECT count(*) AS n FROM passkeys')).toBe(0)
  })
})

describe('вход по ключу', () => {
  async function withKey(o: Partial<ConstructorParameters<typeof SoftAuthenticator>[0]> = {}) {
    const ctx = await setup()
    const key = newKey(o)
    expect((await registerKey(ctx, key)).status).toBe(201)
    return { ctx, key }
  }

  it('без сессии: новая сессия Strict, метод passkey, событие в журнале', async () => {
    const { ctx, key } = await withKey()
    const res = await loginWith(ctx, key)
    expect(res.status).toBe(200)
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))!
    expect(cookie).toMatch(/SameSite=Strict/)
    const me = await (await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie.split(';')[0]! } }))).json()
    expect(me.session).toMatchObject({ authMethod: 'passkey', fresh: true })
    expect(ctx.sql.prepare("SELECT method FROM security_log WHERE event = 'login' ORDER BY id DESC").get()).toEqual({ method: 'passkey' })
  })

  it('поверх старой сессии — «свежий вход»: новая сессия, старая удалена', async () => {
    const { ctx, key } = await withKey()
    const later = Date.now() + 10 * 60_000
    const res = await loginWith(ctx, key, { cookie: ctx.cookie, now: later })
    expect(res.status).toBe(200)
    expect((await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: ctx.cookie } }), later)).status).toBe(401)
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(1)
  })

  it('синхронизируемый ключ со счётчиком 0 входит повторно', async () => {
    const { ctx, key } = await withKey({ counter: 0 })
    expect((await loginWith(ctx, key)).status).toBe(200)
    expect((await loginWith(ctx, key)).status).toBe(200)
  })

  it('счётчик растёт и сохраняется; откат счётчика (клон ключа) — отказ', async () => {
    const { ctx, key } = await withKey({ counter: 5 })
    expect((await loginWith(ctx, key)).status).toBe(200)
    expect(ctx.sql.prepare('SELECT counter FROM passkeys').get()).toEqual({ counter: 6 })
    key.counter = 3
    expect((await loginWith(ctx, key)).status).toBe(401)
  })

  it.each([
    ['без проверки пользователя (UV)', (k: SoftAuthenticator) => (k.userVerified = false)],
    ['с чужого адреса', (k: SoftAuthenticator) => (k.origin = 'https://evil.example')],
  ])('%s — 401 и запись в журнале', async (_n, spoil) => {
    const { ctx, key } = await withKey()
    spoil(key)
    const res = await loginWith(ctx, key)
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
    expect(count(ctx, "SELECT count(*) AS n FROM security_log WHERE event = 'passkey_failed'")).toBe(1)
  })

  it('подпись под другим вызовом (повтор перехваченного ответа) — 401', async () => {
    const { ctx, key } = await withKey()
    const first = await ctx.send(mutation('POST', '/api/auth/passkey/options', ''))
    const stale = key.login((await first.json()).options.challenge)
    const second = await ctx.send(mutation('POST', '/api/auth/passkey/options', ''))
    const res = await ctx.send(mutation('POST', '/api/auth/passkey', `${WEBAUTHN_COOKIE}=${cookieFrom(second, WEBAUTHN_COOKIE)}`, { response: stale }))
    expect(res.status).toBe(401)
  })

  it('подделанная подпись — 401', async () => {
    const { ctx, key } = await withKey()
    const res = await loginWith(ctx, key, { tamper: (r) => (r.response.signature = r.response.signature.slice(0, -4) + 'AAAA') })
    expect(res.status).toBe(401)
  })

  it('неизвестный ключ — 401; после 20 неудач за 15 минут — 429', async () => {
    const { ctx } = await withKey()
    const stranger = newKey()
    for (let i = 0; i < 20; i++) expect((await loginWith(ctx, stranger)).status).toBe(401)
    expect((await loginWith(ctx, stranger)).status).toBe(429)
    expect((await loginWith(ctx, stranger, { now: Date.now() + 16 * 60_000 })).status).toBe(401)
  })

  it('без cookie вызова или без X-Hub — отказ', async () => {
    const { ctx, key } = await withKey()
    const opt = await ctx.send(mutation('POST', '/api/auth/passkey/options', ''))
    const response = key.login((await opt.json()).options.challenge)
    expect((await ctx.send(mutation('POST', '/api/auth/passkey', '', { response }))).status).toBe(400)
    const noHub = new Request(`${ORIGIN}/api/auth/passkey/options`, { method: 'POST', headers: { Origin: ORIGIN } })
    expect((await ctx.send(noHub)).status).toBe(403)
  })

  it('выдача вызова ничего не пишет в базу', async () => {
    const ctx = await setup()
    const before = count(ctx, 'SELECT count(*) AS n FROM security_log')
    for (let i = 0; i < 5; i++) await ctx.send(mutation('POST', '/api/auth/passkey/options', ''))
    expect(count(ctx, 'SELECT count(*) AS n FROM security_log')).toBe(before)
  })
})

describe('«Ключи и входы»', () => {
  it('список ключей; удаление — при свежем входе и с записью в журнал', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key, { name: 'Ноутбук' })
    const list = await (await ctx.send(new Request(`${ORIGIN}/api/passkeys`, { headers: { Cookie: ctx.cookie } }))).json()
    expect(list.passkeys).toMatchObject([{ id: key.id, name: 'Ноутбук', lastUsedAt: null }])

    const stale = await ctx.send(mutation('DELETE', `/api/passkeys/${key.id}`, ctx.cookie), Date.now() + 6 * 60_000)
    expect(stale.status).toBe(403)
    expect((await ctx.send(mutation('DELETE', `/api/passkeys/${key.id}`, ctx.cookie))).status).toBe(200)
    expect(count(ctx, 'SELECT count(*) AS n FROM passkeys')).toBe(0)
    expect(count(ctx, "SELECT count(*) AS n FROM security_log WHERE event = 'passkey_removed'")).toBe(1)
    expect((await ctx.send(mutation('DELETE', `/api/passkeys/${key.id}`, ctx.cookie))).status).toBe(404)
    // Удалённым ключом больше не войти.
    expect((await loginWith(ctx, key)).status).toBe(401)
  })

  it('«Выйти везде»: при свежем входе, все сессии удалены, данные сайта стёрты', async () => {
    const ctx = await setup()
    const other = await session(ctx.env, ctx.gh.fn)
    expect((await ctx.send(mutation('POST', '/api/auth/logout-all', ctx.cookie), Date.now() + 6 * 60_000)).status).toBe(403)
    const res = await ctx.send(mutation('POST', '/api/auth/logout-all', ctx.cookie))
    expect(res.status).toBe(200)
    expect(res.headers.get('Clear-Site-Data')).toBe('"cache", "storage"')
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(0)
    expect((await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: other } }))).status).toBe(401)
  })

  it('список входов отмечает текущее устройство', async () => {
    const ctx = await setup()
    await session(ctx.env, ctx.gh.fn)
    const { sessions } = await (await ctx.send(new Request(`${ORIGIN}/api/sessions`, { headers: { Cookie: ctx.cookie } }))).json()
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
  })

  it('плашка: вход через GitHub и новый ключ до этой сессии видны, после «видел» — нет', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    const later = Date.now() + 60_000
    const res = await loginWith(ctx, key, { now: later })
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))!.split(';')[0]!
    const me = async () => (await (await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }), later)).json()).unseenSecurityEvents
    expect(await me()).toBe(2) // вход через GitHub + добавленный ключ; сам вход по ключу — не повод для плашки
    expect((await ctx.send(mutation('POST', '/api/security/seen', cookie), later)).status).toBe(200)
    expect(await me()).toBe(0)
    const log = await (await ctx.send(new Request(`${ORIGIN}/api/security`, { headers: { Cookie: cookie } }), later)).json()
    expect(log.events.map((e: { event: string }) => e.event)).toEqual(['login', 'passkey_added', 'login'])
  })
})
