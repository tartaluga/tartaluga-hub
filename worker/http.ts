// Ответы и разбор запросов API. Наружу — только коды ошибок и тексты хаба, без тел ответов GitHub и стеков.

/** Заголовки каждого ответа API (на ответы Worker файл _headers не действует). */
const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(API_HEADERS)
  if (extra) new Headers(extra).forEach((v, k) => headers.append(k, v))
  return new Response(JSON.stringify(body), { status, headers })
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'fresh_login_required'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'payload_too_large'
  | 'validation'
  | 'rate_limited'
  | 'upstream'
  | 'server'

/** Ошибка, которую обработчик бросает, а роутер превращает в ответ { error: { code, message } }. */
export class HttpError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details?: unknown
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function errorResponse(e: HttpError, extra?: HeadersInit): Response {
  return json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }, e.status, extra)
}

/** Редирект для шагов входа (не API-JSON). */
export function redirect(location: string, extra?: HeadersInit): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  if (extra) new Headers(extra).forEach((v, k) => headers.append(k, v))
  return new Response(null, { status: 302, headers })
}

export function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export interface CookieOptions {
  maxAge: number // секунды; 0 — удалить
  sameSite: 'Strict' | 'Lax'
}

/** Только cookie с префиксом __Host-: Secure, Path=/, без Domain — браузер не даст их подменить с поддомена. */
export function setCookie(name: string, value: string, opts: CookieOptions): string {
  if (!name.startsWith('__Host-')) throw new Error('cookie must use __Host- prefix')
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${opts.sameSite}; Max-Age=${opts.maxAge}`
}

export function clearCookie(name: string, sameSite: 'Strict' | 'Lax' = 'Strict'): string {
  return setCookie(name, '', { maxAge: 0, sameSite })
}

/**
 * Защита изменяющих запросов от подделки: точный Origin нашего адреса и заголовок X-Hub: 1
 * (его нельзя поставить с чужого сайта без CORS-preflight, а CORS мы не разрешаем).
 */
export function assertSameOriginMutation(request: Request, appOrigin: string): void {
  if (request.headers.get('Origin') !== appOrigin || request.headers.get('X-Hub') !== '1') {
    throw new HttpError(403, 'forbidden', 'Запрос не с адреса хаба')
  }
}

/** Тело JSON с пределом размера (ADR-007: JSON до 1 МБ, с картинкой в base64 — чуть больше). */
export async function readJson<T>(request: Request, limitBytes: number): Promise<T> {
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'bad_request', 'Ожидается application/json')
  }
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > limitBytes) throw new HttpError(413, 'payload_too_large', 'Слишком большой запрос')
  const buf = await readLimited(request, limitBytes)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)) as T
  } catch {
    throw new HttpError(400, 'bad_request', 'Тело запроса — не JSON')
  }
}

async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new HttpError(413, 'payload_too_large', 'Слишком большой запрос')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** Браузер и ОС из User-Agent для списка входов — без версий и прочих подробностей (ADR-007, личные данные). */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'неизвестно'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'другая ОС'
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'браузер'
  return `${browser}, ${os}`
}
