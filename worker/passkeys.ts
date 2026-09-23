// Вход по ключу доступа (ADR-007): discoverable-ключи, userVerification: required, rpId — точный хост.
// Вызов (challenge) живёт в подписанной cookie 5 минут, а не в базе: анонимные запросы ничего не пишут в D1.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { sha256, signValue, verifyValue } from './crypto'
import type { Env } from './env'
import { clearCookie, deviceLabel, getCookie, HttpError, json, readJson, setCookie } from './http'
import { createSession, logEvent, type Session } from './sessions'
import { requireFresh } from './write'

export const WEBAUTHN_COOKIE = '__Host-hub_webauthn'
const CHALLENGE_TTL = 5 * 60_000
const FAILED_LIMIT = 20 // неудачных проверок ключа за 15 минут — дальше 429
const FAILED_WINDOW = 15 * 60_000

const rpId = (env: Env) => new URL(env.APP_ORIGIN).hostname

interface Challenge {
  c: string
  s?: string // хэш сессии, для которой начата регистрация ключа
}

async function challengeCookie(env: Env, purpose: 'reg' | 'auth', value: Challenge): Promise<string> {
  return setCookie(WEBAUTHN_COOKIE, await signValue(env.COOKIE_SECRET, purpose, value, CHALLENGE_TTL), {
    maxAge: CHALLENGE_TTL / 1000,
    sameSite: 'Strict',
  })
}

/** Вызов из cookie; одноразовый — ответ всегда стирает cookie. */
async function takeChallenge(request: Request, env: Env, purpose: 'reg' | 'auth'): Promise<Challenge> {
  const saved = await verifyValue<Challenge>(env.COOKIE_SECRET, purpose, getCookie(request, WEBAUTHN_COOKIE))
  if (!saved) throw new HttpError(400, 'bad_request', 'Время на подтверждение вышло, попробуй ещё раз')
  return saved
}

const withCleared = (res: Response) => (res.headers.append('Set-Cookie', clearCookie(WEBAUTHN_COOKIE)), res)

/** Постоянный id пользователя для ключей: не содержит ничего личного, одинаков на всех устройствах. */
async function userId(env: Env): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array((await sha256(`tartaluga-hub:${env.OWNER_GITHUB_ID}`)).slice(0, 16))
}

interface PasskeyRow {
  id: string
  public_key: ArrayBuffer | Uint8Array
  counter: number
  transports: string
  name: string
  created_at: number
  last_used_at: number | null
}

const transportsOf = (row: PasskeyRow): string[] => {
  try {
    const t = JSON.parse(row.transports) as unknown
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// ---------- Регистрация (только при свежем входе) ----------

/** POST /api/passkeys/register/options */
export async function registrationOptions(env: Env, session: Session, now: number): Promise<Response> {
  requireFresh(session, now)
  const { results } = await env.DB.prepare('SELECT id, transports FROM passkeys').all<PasskeyRow>()
  const options = await generateRegistrationOptions({
    rpName: 'Tartaluga Hub',
    rpID: rpId(env),
    userID: await userId(env),
    userName: 'tartaluga',
    userDisplayName: 'Tartaluga Hub',
    attestationType: 'none',
    timeout: CHALLENGE_TTL,
    // Тот же ключ дважды не добавить.
    excludeCredentials: results.map((r) => ({ id: r.id, transports: transportsOf(r) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  return json({ options }, 200, { 'Set-Cookie': await challengeCookie(env, 'reg', { c: options.challenge, s: session.idHash }) })
}

/** POST /api/passkeys/register — {response, name?} */
export async function register(request: Request, env: Env, session: Session, now: number): Promise<Response> {
  requireFresh(session, now)
  const saved = await takeChallenge(request, env, 'reg')
  // Вызов выдан именно этой сессии: чужая сессия не завершит начатую регистрацию.
  if (saved.s !== session.idHash) throw new HttpError(400, 'bad_request', 'Время на подтверждение вышло, попробуй ещё раз')
  const body = await readJson<{ response?: RegistrationResponseJSON; name?: unknown }>(request, 64 * 1024)
  if (!body.response || typeof body.response !== 'object') throw new HttpError(400, 'bad_request', 'Нет ответа ключа')

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: saved.c,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: rpId(env),
      requireUserVerification: true,
    })
  } catch (e) {
    console.error('passkey registration rejected', e instanceof Error ? e.message : typeof e)
    verification = { verified: false as const }
  }
  if (!verification.verified) throw new HttpError(400, 'bad_request', 'Ключ не прошёл проверку')

  const { credential } = verification.registrationInfo
  const device = deviceLabel(request.headers.get('User-Agent'))
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : device
  const inserted = await env.DB.prepare(
    'INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
  )
    .bind(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), name, now)
    .run()
  if (!inserted.meta.changes) throw new HttpError(409, 'conflict', 'Этот ключ уже добавлен')
  await logEvent(env.DB, 'passkey_added', { method: session.authMethod, device, detail: name }, now)
  return withCleared(json({ id: credential.id, name }, 201))
}

// ---------- Вход ----------

/** POST /api/auth/passkey/options — анонимно, без записи в D1. */
export async function authenticationOptions(env: Env): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: rpId(env), userVerification: 'required', timeout: CHALLENGE_TTL })
  return json({ options }, 200, { 'Set-Cookie': await challengeCookie(env, 'auth', { c: options.challenge }) })
}

/** POST /api/auth/passkey — {response}. Успех — новая сессия (и «свежий вход» для уже вошедшего). */
export async function authenticate(request: Request, env: Env, now: number): Promise<Response> {
  const saved = await takeChallenge(request, env, 'auth')
  await assertNotThrottled(env, now)
  const body = await readJson<{ response?: AuthenticationResponseJSON }>(request, 64 * 1024)
  const response = body.response
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') throw new HttpError(400, 'bad_request', 'Нет ответа ключа')
  const device = deviceLabel(request.headers.get('User-Agent'))

  const row = /^[A-Za-z0-9_-]{1,1024}$/.test(response.id)
    ? await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(response.id).first<PasskeyRow>()
    : null
  if (!row) return failed(env, device, 'неизвестный ключ', now)

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: saved.c,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: rpId(env),
      requireUserVerification: true,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transportsOf(row) },
    })
  } catch (e) {
    console.error('passkey assertion rejected', e instanceof Error ? e.message : typeof e)
    verification = null
  }
  if (!verification?.verified) return failed(env, device, row.name, now)

  await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, now, row.id)
    .run()
  const { setCookie: sessionCookie } = await createSession(env.DB, request, 'passkey', device, now)
  await logEvent(env.DB, 'login', { method: 'passkey', device, detail: row.name }, now)
  const res = withCleared(json({ ok: true }))
  res.headers.append('Set-Cookie', sessionCookie)
  return res
}

async function assertNotThrottled(env: Env, now: number): Promise<void> {
  const recent = await env.DB.prepare("SELECT count(*) AS n FROM security_log WHERE event = 'passkey_failed' AND at > ?")
    .bind(now - FAILED_WINDOW)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= FAILED_LIMIT) throw new HttpError(429, 'rate_limited', 'Слишком много неудачных попыток, подожди 15 минут')
}

async function failed(env: Env, device: string, detail: string, now: number): Promise<Response> {
  await logEvent(env.DB, 'passkey_failed', { method: 'passkey', device, detail }, now)
  return withCleared(json({ error: { code: 'unauthorized', message: 'Ключ не подошёл' } }, 401))
}

// ---------- «Ключи и входы» ----------

/** GET /api/passkeys */
export async function listPasskeys(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at').all<PasskeyRow>()
  return json({ passkeys: results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })) })
}

/** DELETE /api/passkeys/:id — при свежем входе. Синхронизируемый ключ удаляется везде, где он есть. */
export async function deletePasskey(id: string, env: Env, session: Session, now: number): Promise<Response> {
  requireFresh(session, now)
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id)) throw new HttpError(400, 'bad_request', 'Неверный id ключа')
  const row = await env.DB.prepare('SELECT name FROM passkeys WHERE id = ?').bind(id).first<{ name: string }>()
  if (!row) throw new HttpError(404, 'not_found', 'Нет такого ключа')
  await env.DB.prepare('DELETE FROM passkeys WHERE id = ?').bind(id).run()
  await logEvent(env.DB, 'passkey_removed', { method: session.authMethod, device: session.device, detail: row.name }, now)
  return json({ ok: true })
}
