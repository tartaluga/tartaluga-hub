// «Ключи и входы» (ADR-007): сессии, «Выйти везде», журнал безопасности и плашка о событиях.
import type { Env } from './env'
import { HttpError, json } from './http'
import { clearSessionCookie, deleteAllSessions, logEvent, type Session } from './sessions'
import { requireFresh } from './write'

/** События, о которых владелец должен узнать плашкой при следующем входе. */
const NOTABLE = ['login', 'login_denied', 'passkey_added', 'passkey_removed', 'logout_all', 'session_revoked', 'passkey_failed']
const NOTABLE_SQL = NOTABLE.map((e) => `'${e}'`).join(', ')

/** Сколько важных событий случилось до этой сессии и ещё не показано. Вход по ключу — обычное дело, не считается. */
export async function unseenCount(env: Env, session: Session): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM security_log WHERE seen = 0 AND at < ? AND event IN (${NOTABLE_SQL}) AND NOT (event = 'login' AND method = 'passkey')`,
  )
    .bind(session.createdAt)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** GET /api/security — последние 100 событий. */
export async function securityLog(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT at, event, method, device, detail, seen FROM security_log ORDER BY at DESC, id DESC LIMIT 100').all<{
    at: number
    event: string
    method: string
    device: string
    detail: string
    seen: number
  }>()
  return json({ events: results.map((r) => ({ ...r, seen: r.seen === 1 })) })
}

/** POST /api/security/seen — владелец увидел плашку. */
export async function markSeen(env: Env, session: Session): Promise<Response> {
  await env.DB.prepare('UPDATE security_log SET seen = 1 WHERE seen = 0 AND at < ?').bind(session.createdAt).run()
  return json({ ok: true })
}

/** GET /api/sessions — где выполнен вход. */
export async function listSessions(env: Env, session: Session, now: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id_hash, created_at, last_used_at, auth_method, device FROM sessions WHERE expires_at > ? ORDER BY last_used_at DESC',
  )
    .bind(now)
    .all<{ id_hash: string; created_at: number; last_used_at: number; auth_method: string; device: string }>()
  return json({
    sessions: results.map((r) => ({
      // Хэш id сессии: по нему можно только завершить сессию, войти с ним нельзя (cookie хэшируется заново).
      id: r.id_hash,
      current: r.id_hash === session.idHash,
      device: r.device,
      method: r.auth_method,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  })
}

/** POST /api/auth/logout-all — при свежем входе. Все устройства, включая это, выходят. */
export async function logoutAll(env: Env, session: Session, now: number): Promise<Response> {
  requireFresh(session, now)
  await deleteAllSessions(env.DB)
  await logEvent(env.DB, 'logout_all', { method: session.authMethod, device: session.device }, now)
  const headers = new Headers({ 'Clear-Site-Data': '"cache", "storage"' })
  headers.append('Set-Cookie', clearSessionCookie())
  return json({ ok: true }, 200, headers)
}

/**
 * DELETE /api/sessions/:idHash — завершить вход на другом устройстве. При свежем входе, как «Выйти везде».
 * Текущую сессию так не завершить: для неё «Выйти» (стирает cookie и данные сайта).
 */
export async function deleteOtherSession(idHash: string, env: Env, session: Session, now: number): Promise<Response> {
  requireFresh(session, now)
  if (!/^[0-9a-f]{64}$/.test(idHash)) throw new HttpError(400, 'bad_request', 'Неверный id сессии')
  if (idHash === session.idHash) throw new HttpError(400, 'bad_request', 'Это устройство — для него кнопка «Выйти»')
  // Одним запросом: два одновременных DELETE не пройдут оба и не запишут событие дважды.
  const row = await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ? AND expires_at > ? RETURNING device').bind(idHash, now).first<{ device: string }>()
  if (!row) throw new HttpError(404, 'not_found', 'Такого входа уже нет')
  await logEvent(env.DB, 'session_revoked', { method: session.authMethod, device: session.device, detail: row.device }, now)
  return json({ ok: true })
}
