// Сессии (ADR-007): случайный 256-битный id в cookie __Host-hub_session, в D1 — только его SHA-256.
// Срок 30 дней со скользящим продлением, но не больше 90 дней от входа.
import { randomToken, sha256Hex } from './crypto'
import { clearCookie, getCookie, setCookie } from './http'

export const SESSION_COOKIE = '__Host-hub_session'
export const DAY = 24 * 60 * 60_000
export const SESSION_TTL = 30 * DAY
export const SESSION_MAX = 90 * DAY
export const FRESH_LOGIN = 5 * 60_000
const TOUCH_EVERY = 60 * 60_000 // продлеваем не чаще раза в час, чтобы не писать в D1 на каждый запрос
export const LOG_RETENTION = 180 * DAY

export type AuthMethod = 'github' | 'passkey'

export interface Session {
  idHash: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number
  authAt: number
  authMethod: AuthMethod
  device: string
}

interface Row {
  id_hash: string
  created_at: number
  expires_at: number
  last_used_at: number
  auth_at: number
  auth_method: AuthMethod
  device: string
}

const fromRow = (r: Row): Session => ({
  idHash: r.id_hash,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  authAt: r.auth_at,
  authMethod: r.auth_method,
  device: r.device,
})

function sessionCookie(id: string, expiresAt: number, now: number): string {
  return setCookie(SESSION_COOKIE, id, { maxAge: Math.max(0, Math.floor((expiresAt - now) / 1000)), sameSite: 'Strict' })
}

/**
 * Новая сессия после входа. Старая сессия этого браузера (если была) удаляется:
 * при каждом входе — новый id, иначе возможна фиксация сессии.
 */
export async function createSession(
  db: D1Database,
  request: Request,
  method: AuthMethod,
  device: string,
  now = Date.now(),
): Promise<{ session: Session; setCookie: string }> {
  const id = randomToken(32)
  const session: Session = {
    idHash: await sha256Hex(id),
    createdAt: now,
    expiresAt: now + SESSION_TTL,
    lastUsedAt: now,
    authAt: now,
    authMethod: method,
    device,
  }
  const old = getCookie(request, SESSION_COOKIE)
  const statements = [
    db
      .prepare('INSERT INTO sessions (id_hash, created_at, expires_at, last_used_at, auth_at, auth_method, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(session.idHash, session.createdAt, session.expiresAt, session.lastUsedAt, session.authAt, session.authMethod, session.device),
  ]
  if (old) statements.unshift(db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256Hex(old)))
  await db.batch(statements)
  return { session, setCookie: sessionCookie(id, session.expiresAt, now) }
}

/** Действующая сессия запроса или null. setCookie — продлённая cookie, если срок сдвинулся. */
export async function readSession(
  db: D1Database,
  request: Request,
  now = Date.now(),
): Promise<{ session: Session; setCookie?: string } | null> {
  const id = getCookie(request, SESSION_COOKIE)
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null
  const idHash = await sha256Hex(id)
  const row = await db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?').bind(idHash, now).first<Row>()
  if (!row) return null
  const session = fromRow(row)
  if (now - session.lastUsedAt < TOUCH_EVERY) return { session }

  const expiresAt = Math.min(now + SESSION_TTL, session.createdAt + SESSION_MAX)
  await db.prepare('UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE id_hash = ?').bind(expiresAt, now, idHash).run()
  return { session: { ...session, expiresAt, lastUsedAt: now }, setCookie: sessionCookie(id, expiresAt, now) }
}

export function isFresh(session: Session, now = Date.now()): boolean {
  return now - session.authAt <= FRESH_LOGIN
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run()
}

export async function deleteAllSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM sessions').run()
}

export const clearSessionCookie = () => clearCookie(SESSION_COOKIE)

export async function logEvent(db: D1Database, event: string, fields: { method?: string; device?: string; detail?: string } = {}, now = Date.now()): Promise<void> {
  await db
    .prepare('INSERT INTO security_log (at, event, method, device, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(now, event, fields.method ?? '', fields.device ?? '', (fields.detail ?? '').slice(0, 200))
    .run()
}

/** Ежедневная уборка (Cron Trigger): истёкшие сессии и журнал старше 180 дней. */
export async function cleanup(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM security_log WHERE at < ?').bind(now - LOG_RETENTION),
  ])
}
