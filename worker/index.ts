// Точка входа Worker (ADR-007). Статику отдаёт Cloudflare сам (с заголовками из public/_headers);
// сюда попадают только запросы /api/* (run_worker_first в wrangler.jsonc).
import { GitHubError } from '../src/lib/github'
import { listFiles, readBlob, readStatus } from './api'
import { CALLBACK_PATH, githubCallback, githubStart } from './authGithub'
import { checkBuild } from './build'
import type { Env } from './env'
import { deleteOtherSession, listSessions, logoutAll, markSeen, securityLog, unseenCount } from './account'
import { authenticate, authenticationOptions, deletePasskey, listPasskeys, register, registrationOptions } from './passkeys'
import { commit, createBranch, deleteBranch, listBranches, mergeBranch, putFile, refreshStatus } from './write'
import { assertSameOriginMutation, errorResponse, HttpError, json } from './http'
import { cleanup, clearSessionCookie, deleteSession, isFresh, logEvent, readSession, type Session } from './sessions'

export interface Deps {
  fetch: typeof fetch
  now: () => number
}

const defaultDeps: Deps = { fetch: (input, init) => fetch(input, init), now: () => Date.now() }

export async function handle(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

  let refreshedCookie: string | undefined
  try {
    const res = await route(request, url, env, deps, (c) => (refreshedCookie = c))
    if (refreshedCookie) res.headers.append('Set-Cookie', refreshedCookie)
    return res
  } catch (e) {
    return errorResponse(toHttpError(e))
  }
}

async function route(request: Request, url: URL, env: Env, deps: Deps, onRefresh: (cookie: string) => void): Promise<Response> {
  const { pathname } = url
  const method = request.method

  // Входы — единственные маршруты без сессии.
  if (pathname === '/api/auth/github/start') {
    allow(method, 'GET')
    return githubStart(env)
  }
  if (pathname === CALLBACK_PATH) {
    allow(method, 'GET')
    return githubCallback(request, env, deps.fetch)
  }
  if (pathname === '/api/auth/passkey/options') {
    allow(method, 'POST')
    assertSameOriginMutation(request, env.APP_ORIGIN)
    return authenticationOptions(env)
  }
  if (pathname === '/api/auth/passkey') {
    allow(method, 'POST')
    assertSameOriginMutation(request, env.APP_ORIGIN)
    return authenticate(request, env, deps.now())
  }

  // Всё остальное — только с действующей сессией (запрет по умолчанию).
  if (method !== 'GET') assertSameOriginMutation(request, env.APP_ORIGIN)
  const found = await readSession(env.DB, request, deps.now())
  if (!found) throw new HttpError(401, 'unauthorized', 'Нужно войти')
  if (found.setCookie) onRefresh(found.setCookie)
  const session = found.session
  // Запись от устаревшей сборки хаба — 409 stale_build (ADR-011 §3); одно место для всех изменяющих запросов.
  const staleBuild = await checkBuild(request, pathname, env)
  if (staleBuild) return staleBuild

  const now = deps.now()
  if (pathname === '/api/me') {
    allow(method, 'GET')
    return me(session, now, await unseenCount(env, session))
  }
  if (pathname === '/api/auth/logout') {
    allow(method, 'POST')
    return logout(env, session)
  }
  if (pathname === '/api/auth/logout-all') {
    allow(method, 'POST')
    return logoutAll(env, session, now)
  }
  if (pathname === '/api/sessions') {
    allow(method, 'GET')
    return listSessions(env, session, now)
  }
  const sessionRoute = /^\/api\/sessions\/([^/]+)$/.exec(pathname)
  if (sessionRoute) {
    allow(method, 'DELETE')
    return deleteOtherSession(sessionRoute[1]!, env, session, now)
  }
  if (pathname === '/api/security') {
    allow(method, 'GET')
    return securityLog(env)
  }
  if (pathname === '/api/security/seen') {
    allow(method, 'POST')
    return markSeen(env, session)
  }
  if (pathname === '/api/passkeys') {
    allow(method, 'GET')
    return listPasskeys(request, env, session, now)
  }
  if (pathname === '/api/passkeys/register/options') {
    allow(method, 'POST')
    return registrationOptions(env, session, now)
  }
  if (pathname === '/api/passkeys/register') {
    allow(method, 'POST')
    return register(request, env, session, now)
  }
  const passkeyRoute = /^\/api\/passkeys\/([^/]+)$/.exec(pathname)
  if (passkeyRoute) {
    allow(method, 'DELETE')
    return deletePasskey(passkeyRoute[1]!, env, session, now)
  }
  if (pathname === '/api/files') {
    allow(method, 'GET')
    return listFiles(url, env, deps.fetch)
  }
  if (pathname.startsWith('/api/blob/')) {
    allow(method, 'GET')
    return readBlob(pathname.slice('/api/blob/'.length), env, deps.fetch)
  }
  if (pathname === '/api/status') {
    allow(method, 'GET')
    return readStatus(env, deps.fetch)
  }
  if (pathname === '/api/status/refresh') {
    allow(method, 'POST')
    return refreshStatus(env, deps.fetch)
  }
  if (pathname === '/api/file') {
    allow(method, 'PUT')
    return putFile(request, env, deps.fetch)
  }
  if (pathname === '/api/commit') {
    allow(method, 'POST')
    return commit(request, env, deps.fetch)
  }
  if (pathname === '/api/branches') {
    if (method === 'GET') return listBranches(env, deps.fetch)
    allow(method, 'POST')
    return createBranch(request, env, deps.fetch)
  }
  const branchRoute = /^\/api\/branches\/([^/]+)(\/merge)?$/.exec(pathname)
  if (branchRoute) {
    // Имя ветки — только [a-z0-9-], так что процент-кодирование не нужно и не принимается.
    const name = branchRoute[1]!
    if (branchRoute[2]) {
      allow(method, 'POST')
      return mergeBranch(name, env, deps.fetch)
    }
    allow(method, 'DELETE')
    return deleteBranch(name, session, now, env, deps.fetch)
  }
  throw new HttpError(404, 'not_found', 'Нет такой команды')
}

function allow(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, 'method_not_allowed', 'Метод не поддерживается')
}

function me(session: Session, now: number, unseenSecurityEvents: number): Response {
  return json({
    unseenSecurityEvents,
    session: {
      authMethod: session.authMethod,
      authAt: session.authAt,
      fresh: isFresh(session, now),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      device: session.device,
    },
  })
}

async function logout(env: Env, session: Session): Promise<Response> {
  await deleteSession(env.DB, session.idHash)
  await logEvent(env.DB, 'logout', { method: session.authMethod, device: session.device })
  // Браузер сам стирает кэш и хранилища сайта, даже если скрипт не успеет (ADR-007, раскрытие).
  const headers = new Headers({ 'Clear-Site-Data': '"cache", "storage"' })
  headers.append('Set-Cookie', clearSessionCookie())
  return json({ ok: true }, 200, headers)
}

function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e
  if (e instanceof GitHubError) {
    switch (e.kind) {
      case 'conflict':
      case 'already_exists':
        return new HttpError(409, 'conflict', 'Данные уже изменили')
      case 'not_found':
        return new HttpError(404, 'not_found', 'Не найдено в репо данных')
      case 'rate_limited':
        return new HttpError(429, 'rate_limited', 'GitHub просит подождать')
      default:
        console.error('github error', e.kind, e.status)
        return new HttpError(502, 'upstream', 'GitHub не ответил как надо')
    }
  }
  // В журнал Cloudflare — имя и текст ошибки (секретов в них нет), наружу — только общий код.
  console.error('unhandled', e instanceof Error ? `${e.name}: ${e.message}` : typeof e)
  return new HttpError(500, 'server', 'Ошибка сервера')
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: async (_controller, env) => {
    await cleanup(env.DB)
  },
} satisfies ExportedHandler<Env>
