import { beforeEach, describe, expect, it } from 'vitest'
import { resetGitHubAppCaches } from '../githubApp'
import { sha256Hex } from '../crypto'
import { DEVICE_KEY_COOKIE, WEBAUTHN_COOKIE } from '../passkeys'
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

describe('ключ этого устройства', () => {
  const get = (ctx: Ctx, cookie: string) => ctx.send(new Request(`${ORIGIN}/api/passkeys`, { headers: { Cookie: cookie } }))
  const devCookie = (res: Response) => `${DEVICE_KEY_COOKIE}=${cookieFrom(res, DEVICE_KEY_COOKIE)}`

  it('добавленный здесь ключ помечен; на другом устройстве (без cookie) — нет', async () => {
    const ctx = await setup()
    const key = newKey()
    const res = await registerKey(ctx, key, { name: 'Ноутбук' })
    expect(res.headers.getSetCookie().find((c) => c.startsWith(DEVICE_KEY_COOKIE))).toMatch(/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000$/)
    const here = await (await get(ctx, `${ctx.cookie}; ${devCookie(res)}`)).json()
    expect(here).toMatchObject({ thisDevice: true, passkeys: [{ id: key.id, thisDevice: true }] })
    const elsewhere = await (await get(ctx, ctx.cookie)).json()
    expect(elsewhere).toMatchObject({ thisDevice: false, passkeys: [{ id: key.id, thisDevice: false }] })
  })

  it('вход ключом ставит cookie устройства; сессия по ключу без cookie тоже считается', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    const res = await loginWith(ctx, key)
    const sessionCookie = `${SESSION_COOKIE}=${cookieFrom(res, SESSION_COOKIE)}`
    expect((await (await get(ctx, `${sessionCookie}; ${devCookie(res)}`)).json()).passkeys[0].thisDevice).toBe(true)
    expect((await (await get(ctx, sessionCookie)).json()).thisDevice).toBe(true)
  })

  it('подделанная cookie и cookie удалённого ключа не считаются', async () => {
    const ctx = await setup()
    const key = newKey()
    const res = await registerKey(ctx, key)
    const good = devCookie(res)
    const forged = good.replace('.', '.AA')
    expect((await (await get(ctx, `${ctx.cookie}; ${forged}`)).json()).thisDevice).toBe(false)
    expect((await ctx.send(mutation('DELETE', `/api/passkeys/${key.id}`, ctx.cookie))).status).toBe(200)
    expect((await (await get(ctx, `${ctx.cookie}; ${good}`)).json()).thisDevice).toBe(false)
  })
})

describe('выход на другом устройстве', () => {
  const hashOf = (cookie: string) => sha256Hex(cookie.split('=')[1]!)
  async function two() {
    const ctx = await setup()
    const other = await session(ctx.env, ctx.gh.fn)
    return { ctx, other, otherHash: await hashOf(other), mine: await hashOf(ctx.cookie) }
  }
  const alive = async (ctx: Ctx, cookie: string) => (await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }))).status === 200

  it('список отдаёт хэш сессии; удаление по нему завершает только ту сессию и пишется в журнал', async () => {
    const { ctx, other, otherHash, mine } = await two()
    const { sessions } = await (await ctx.send(new Request(`${ORIGIN}/api/sessions`, { headers: { Cookie: ctx.cookie } }))).json()
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([otherHash, mine].sort())
    const res = await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ctx.cookie))
    expect(res.status).toBe(200)
    expect(await alive(ctx, other)).toBe(false)
    expect(await alive(ctx, ctx.cookie)).toBe(true)
    expect(ctx.sql.prepare("SELECT method, detail FROM security_log WHERE event = 'session_revoked'").all()).toEqual([
      { method: 'github', detail: expect.any(String) },
    ])
    // Повторно — уже нет такого входа.
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ctx.cookie))).status).toBe(404)
  })

  it('текущую сессию так не удалить', async () => {
    const { ctx, mine } = await two()
    const res = await ctx.send(mutation('DELETE', `/api/sessions/${mine}`, ctx.cookie))
    expect(res.status).toBe(400)
    expect(await alive(ctx, ctx.cookie)).toBe(true)
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(2)
  })

  it('несуществующий и чужой по формату id: 404 и 400, ничего не удалено', async () => {
    const { ctx, other } = await two()
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${'a'.repeat(64)}`, ctx.cookie))).status).toBe(404)
    // Сама cookie вместо хэша не принимается.
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${other.split('=')[1]}`, ctx.cookie))).status).toBe(400)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${'A'.repeat(64)}`, ctx.cookie))).status).toBe(400)
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(2)
    expect(count(ctx, "SELECT count(*) AS n FROM security_log WHERE event = 'session_revoked'")).toBe(0)
  })

  it('без свежего входа — 403; без X-Hub или с чужим Origin — 403; не DELETE — 405', async () => {
    const { ctx, other, otherHash } = await two()
    const stale = await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ctx.cookie), Date.now() + 6 * 60_000)
    expect(stale.status).toBe(403)
    expect((await stale.json()).error.code).toBe('fresh_login_required')
    const noHeader = new Request(`${ORIGIN}/api/sessions/${otherHash}`, { method: 'DELETE', headers: { Cookie: ctx.cookie, Origin: ORIGIN } })
    expect((await ctx.send(noHeader)).status).toBe(403)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ctx.cookie, undefined, { Origin: 'https://evil.example' }))).status).toBe(403)
    expect((await ctx.send(mutation('POST', `/api/sessions/${otherHash}`, ctx.cookie))).status).toBe(405)
    expect(await alive(ctx, other)).toBe(true)
  })

  it('без сессии — 401', async () => {
    const { ctx, other, otherHash } = await two()
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ''))).status).toBe(401)
    expect(await alive(ctx, other)).toBe(true)
  })
})

describe('V4: граничные случаи', () => {
  const get = (ctx: Ctx, cookie: string, now?: number) => ctx.send(new Request(`${ORIGIN}/api/passkeys`, { headers: { Cookie: cookie } }), now)
  const devCookie = (res: Response) => `${DEVICE_KEY_COOKIE}=${cookieFrom(res, DEVICE_KEY_COOKIE)}`
  const hashOf = (cookie: string) => sha256Hex(cookie.split('=')[1]!)
  const sessionOf = (res: Response) => `${SESSION_COOKIE}=${cookieFrom(res, SESSION_COOKIE)}`

  it('без ключей: thisDevice false и пустой список', async () => {
    const ctx = await setup()
    expect(await (await get(ctx, ctx.cookie)).json()).toEqual({ thisDevice: false, passkeys: [] })
  })

  it('из двух ключей помечен только тот, что в cookie', async () => {
    const ctx = await setup()
    const a = newKey()
    const b = newKey()
    await registerKey(ctx, a, { name: 'A' })
    const res = await registerKey(ctx, b, { name: 'B' })
    const body = await (await get(ctx, `${ctx.cookie}; ${devCookie(res)}`)).json()
    expect(body.thisDevice).toBe(true)
    expect(body.passkeys.map((p: { name: string; thisDevice: boolean }) => [p.name, p.thisDevice])).toEqual([
      ['A', false],
      ['B', true],
    ])
  })

  it('сессия по ключу с cookie удалённого ключа — не «это устройство» (cookie важнее способа входа)', async () => {
    const ctx = await setup()
    const a = newKey()
    const b = newKey()
    const regA = await registerKey(ctx, a)
    await registerKey(ctx, b)
    const login = await loginWith(ctx, b)
    const bSession = sessionOf(login)
    expect((await ctx.send(mutation('DELETE', `/api/passkeys/${a.id}`, ctx.cookie))).status).toBe(200)
    // Cookie устройства говорит «ключ A», которого больше нет, а сессия открыта ключом B.
    const body = await (await get(ctx, `${bSession}; ${devCookie(regA)}`)).json()
    expect(body.thisDevice).toBe(false)
    expect(body.passkeys.every((p: { thisDevice: boolean }) => !p.thisDevice)).toBe(true)
  })

  it('сессия по ключу без cookie, но ключей уже нет — false', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    const s = sessionOf(await loginWith(ctx, key))
    expect((await ctx.send(mutation('DELETE', `/api/passkeys/${key.id}`, s))).status).toBe(200)
    expect(await (await get(ctx, s)).json()).toEqual({ thisDevice: false, passkeys: [] })
  })

  it('cookie устройства живёт 400 дней: через 401 день не считается, через 399 — считается', async () => {
    const ctx = await setup()
    const key = newKey()
    const dev = devCookie(await registerKey(ctx, key))
    const day = 24 * 60 * 60_000
    for (const [days, expected] of [
      [399, true],
      [401, false],
    ] as const) {
      const at = Date.now() + days * day
      // Сессию «переносим» в будущее прямо в базе: вход через GitHub в тесте привязан к текущему времени.
      const s = await session(ctx.env, ctx.gh.fn)
      ctx.sql
        .prepare('UPDATE sessions SET created_at = ?, auth_at = ?, last_used_at = ?, expires_at = ? WHERE id_hash = ?')
        .run(at, at, at, at + day, await hashOf(s))
      const r = await get(ctx, `${s}; ${dev}`, at)
      expect(r.status).toBe(200)
      expect((await r.json()).thisDevice).toBe(expected)
    }
  })

  it('cookie устройства — только подпись devkey: сессионная cookie в её роли не принимается', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    const fake = `${DEVICE_KEY_COOKIE}=${ctx.cookie.split('=')[1]}`
    expect((await (await get(ctx, `${ctx.cookie}; ${fake}`)).json()).thisDevice).toBe(false)
  })

  it('журнал: session_revoked — кто завершил и какое устройство; попадает в плашку следующего входа', async () => {
    const ctx = await setup()
    const other = await session(ctx.env, ctx.gh.fn)
    const otherHash = await hashOf(other)
    ctx.sql.prepare('UPDATE sessions SET device = ? WHERE id_hash = ?').run('Android · Chrome', otherHash)
    ctx.sql.prepare('UPDATE sessions SET device = ? WHERE id_hash = ?').run('Windows · Edge', await hashOf(ctx.cookie))
    const t = Date.now() + 1000
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ctx.cookie), t)).status).toBe(200)
    expect(ctx.sql.prepare("SELECT at, event, method, device, detail FROM security_log WHERE event = 'session_revoked'").all()).toEqual([
      { at: t, event: 'session_revoked', method: 'github', device: 'Windows · Edge', detail: 'Android · Chrome' },
    ])
    const later = t + 60_000
    const next = await session(ctx.env, ctx.gh.fn, later)
    ctx.sql.prepare('UPDATE sessions SET created_at = ?, auth_at = ?, last_used_at = ?, expires_at = ? WHERE id_hash = ?').run(later, later, later, later + 3600_000, await hashOf(next))
    // Всё, кроме session_revoked, уже «видел»: плашка должна насчитать ровно это событие.
    ctx.sql.prepare("UPDATE security_log SET seen = 1 WHERE event <> 'session_revoked'").run()
    const unseen = (await (await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: next } }), later)).json()).unseenSecurityEvents
    expect(unseen).toBe(1)
  })

  it('истёкшую сессию не удалить: 404, строка на месте, события нет', async () => {
    const ctx = await setup()
    const other = await session(ctx.env, ctx.gh.fn)
    const otherHash = await hashOf(other)
    ctx.sql.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(Date.now() - 1, otherHash)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}`, ctx.cookie))).status).toBe(404)
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(2)
    expect(count(ctx, "SELECT count(*) AS n FROM security_log WHERE event = 'session_revoked'")).toBe(0)
  })

  it('список входов: id — 64 hex, истёкшие не показаны', async () => {
    const ctx = await setup()
    const other = await session(ctx.env, ctx.gh.fn)
    ctx.sql.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(Date.now() - 1, await hashOf(other))
    const { sessions } = await (await ctx.send(new Request(`${ORIGIN}/api/sessions`, { headers: { Cookie: ctx.cookie } }))).json()
    expect(sessions).toEqual([expect.objectContaining({ id: await hashOf(ctx.cookie), current: true })])
    expect(sessions[0].id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('маршрут: GET по id — 405, вложенный путь и пустой id — не удаляют', async () => {
    const ctx = await setup()
    const other = await session(ctx.env, ctx.gh.fn)
    const otherHash = await hashOf(other)
    expect((await ctx.send(new Request(`${ORIGIN}/api/sessions/${otherHash}`, { headers: { Cookie: ctx.cookie } }))).status).toBe(405)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}/x`, ctx.cookie))).status).not.toBe(200)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/`, ctx.cookie))).status).not.toBe(200)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${otherHash}%0A`, ctx.cookie))).status).toBe(400)
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(2)
  })

  it('чужая сессия, открытая ключом, удаляется так же; событие с методом того, кто удаляет', async () => {
    const ctx = await setup()
    const key = newKey()
    await registerKey(ctx, key)
    const pk = sessionOf(await loginWith(ctx, key))
    const pkHash = await hashOf(pk)
    expect((await ctx.send(mutation('DELETE', `/api/sessions/${pkHash}`, ctx.cookie))).status).toBe(200)
    expect((await ctx.send(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: pk } }))).status).toBe(401)
    expect(ctx.sql.prepare("SELECT method FROM security_log WHERE event = 'session_revoked'").all()).toEqual([{ method: 'github' }])
  })
})
