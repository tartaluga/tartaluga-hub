// Тонкий клиент к серверу хаба (ADR-007). Токенов в браузере нет: сессия — HttpOnly cookie,
// изменяющие запросы несут X-Hub: 1 (сервер без него отказывает — защита от подделки запросов).
import { base64ToBytes } from './base64'

export class ApiError extends Error {
  readonly status: number // 0 — нет сети
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const isNetworkError = (e: unknown) => e instanceof ApiError && e.status === 0

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET'
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(method === 'GET' ? {} : { 'X-Hub': '1' }),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером хаба')
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* не JSON — например, страница ошибки Cloudflare */
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'server', err?.message ?? `Сервер ответил ${res.status}`, err?.details)
  }
  return body as T
}

// ---------- Данные ----------

export interface RemoteFile {
  path: string
  sha: string
  size: number
}

export const listFiles = (branch = 'main') => api<{ branch: string; head: string; files: RemoteFile[] }>(`/api/files?branch=${encodeURIComponent(branch)}`)

export async function readBlobText(sha: string): Promise<string> {
  const { base64 } = await api<{ base64: string }>(`/api/blob/${sha}`)
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64ToBytes(base64))
}

// ---------- Сессия и «Ключи и входы» ----------

export interface Me {
  unseenSecurityEvents: number
  session: { authMethod: 'github' | 'passkey'; authAt: number; fresh: boolean; createdAt: number; expiresAt: number; device: string }
}

export interface Passkey {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

export interface SessionInfo {
  current: boolean
  device: string
  method: 'github' | 'passkey'
  createdAt: number
  lastUsedAt: number
}

export interface SecurityEvent {
  at: number
  event: string
  method: string
  device: string
  detail: string
  seen: boolean
}

export const getMe = () => api<Me>('/api/me')
export const logout = () => api<{ ok: true }>('/api/auth/logout', { method: 'POST' })
export const logoutAll = () => api<{ ok: true }>('/api/auth/logout-all', { method: 'POST' })
export const listPasskeys = () => api<{ passkeys: Passkey[] }>('/api/passkeys')
export const deletePasskey = (id: string) => api<{ ok: true }>(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const listSessions = () => api<{ sessions: SessionInfo[] }>('/api/sessions')
export const securityLog = () => api<{ events: SecurityEvent[] }>('/api/security')
export const markSecuritySeen = () => api<{ ok: true }>('/api/security/seen', { method: 'POST' })

export const GITHUB_LOGIN_URL = '/api/auth/github/start'
