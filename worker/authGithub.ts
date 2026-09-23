// Вход через GitHub (ADR-007): OAuth того же GitHub App с state и PKCE.
// Пускает только владельца по числовому id. Токен пользователя нужен только чтобы узнать id — сразу отзывается.
import { base64url, randomToken, sha256, signValue, verifyValue } from './crypto'
import type { Env } from './env'
import { clearCookie, deviceLabel, getCookie, redirect, setCookie } from './http'
import { USER_AGENT } from './githubApp'
import { createSession, logEvent } from './sessions'

export const OAUTH_COOKIE = '__Host-hub_oauth'
const OAUTH_TTL = 5 * 60_000
export const CALLBACK_PATH = '/api/auth/github/callback'

interface OAuthState {
  s: string // state
  v: string // PKCE code_verifier
}

/** Шаг 1: отправить браузер на github.com. Ничего не пишет в D1 — анонимный запрос. */
export async function githubStart(env: Env): Promise<Response> {
  const state = randomToken(32)
  const verifier = randomToken(32)
  const challenge = base64url(await sha256(verifier))
  const cookie = await signValue(env.COOKIE_SECRET, 'oauth', { s: state, v: verifier } satisfies OAuthState, OAUTH_TTL)

  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', env.GITHUB_APP_CLIENT_ID)
  url.searchParams.set('redirect_uri', env.APP_ORIGIN + CALLBACK_PATH)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('allow_signup', 'false')
  // SameSite=Lax: иначе браузер не пришлёт cookie при возврате с github.com.
  return redirect(url.toString(), { 'Set-Cookie': setCookie(OAUTH_COOKIE, cookie, { maxAge: OAUTH_TTL / 1000, sameSite: 'Lax' }) })
}

/** Шаг 2: возврат с github.com. Любая ошибка — на главную с кодом ошибки, без подробностей. */
export async function githubCallback(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const clear = { 'Set-Cookie': clearCookie(OAUTH_COOKIE, 'Lax') }
  const fail = (code: string) => redirect(`/?auth_error=${code}`, clear)

  const url = new URL(request.url)
  const saved = await verifyValue<OAuthState>(env.COOKIE_SECRET, 'oauth', getCookie(request, OAUTH_COOKIE))
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (url.searchParams.get('error')) return fail('cancelled')
  if (!saved || !state || state !== saved.s || !code) return fail('expired')

  const token = await exchangeCode(env, code, saved.v, fetchImpl)
  if (!token) return fail('github')
  const user = await fetchUser(token, fetchImpl)
  await revokeToken(env, token, fetchImpl)
  if (!user) return fail('github')

  const device = deviceLabel(request.headers.get('User-Agent'))
  // Проверка владельца при каждом создании сессии.
  if (String(user.id) !== env.OWNER_GITHUB_ID) {
    // Любой аккаунт GitHub может дойти до этой точки. Чтобы им нельзя было забить D1 записями, пишем не больше 20 отказов в час.
    const recent = await env.DB.prepare("SELECT count(*) AS n FROM security_log WHERE event = 'login_denied' AND at > ?")
      .bind(Date.now() - 60 * 60_000)
      .first<{ n: number }>()
    if ((recent?.n ?? 0) < 20) await logEvent(env.DB, 'login_denied', { method: 'github', device, detail: `github id ${user.id}` })
    return fail('not_owner')
  }

  const { setCookie: sessionCookie } = await createSession(env.DB, request, 'github', device)
  await logEvent(env.DB, 'login', { method: 'github', device })
  const headers = new Headers(clear)
  headers.append('Set-Cookie', sessionCookie)
  return redirect('/', headers)
}

async function exchangeCode(env: Env, code: string, verifier: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: env.APP_ORIGIN + CALLBACK_PATH,
        code_verifier: verifier,
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { access_token?: string; error?: string }
    return typeof body.access_token === 'string' && body.access_token ? body.access_token : null
  } catch {
    return null
  }
}

async function fetchUser(token: string, fetchImpl: typeof fetch): Promise<{ id: number } | null> {
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { id?: unknown }
    return typeof body.id === 'number' && Number.isSafeInteger(body.id) ? { id: body.id } : null
  } catch {
    return null
  }
}

/** Токен пользователя больше не нужен: отзываем, чтобы он нигде не жил. */
async function revokeToken(env: Env, token: string, fetchImpl: typeof fetch): Promise<void> {
  try {
    const res = await fetchImpl(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: token }),
    })
    if (res.status !== 204) console.error('revoke user token failed', res.status)
  } catch {
    console.error('revoke user token failed: network')
  }
}
