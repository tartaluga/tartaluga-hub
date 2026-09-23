// Криптографические примитивы сервера: только WebCrypto, без сторонних библиотек.
import { base64ToBytes, bytesToBase64 } from '../src/lib/base64'

export function base64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

/** Случайная строка из n байт (по умолчанию 256 бит). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export async function sha256Hex(data: string): Promise<string> {
  return [...(await sha256(data))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const hmacKeys = new Map<string, Promise<CryptoKey>>()
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    hmacKeys.set(secret, key)
  }
  return key
}

/**
 * Подписанное значение для временных cookie входа: payload + срок + назначение, подпись HMAC-SHA256.
 * purpose не даёт подставить cookie одного шага входа в другой.
 */
export async function signValue(secret: string, purpose: string, payload: unknown, ttlMs: number, now = Date.now()): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify({ p: purpose, e: now + ttlMs, d: payload })))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body)))
  return `${body}.${base64url(sig)}`
}

/** Проверка подписи (в постоянное время — через subtle.verify), назначения и срока. null — не годится. */
export async function verifyValue<T>(secret: string, purpose: string, value: string | undefined, now = Date.now()): Promise<T | null> {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot < 1 || dot !== value.lastIndexOf('.')) return null
  const body = value.slice(0, dot)
  let sig: Uint8Array
  try {
    sig = fromBase64url(value.slice(dot + 1))
  } catch {
    return null
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, new TextEncoder().encode(body))
  if (!ok) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as { p: string; e: number; d: T }
    if (parsed.p !== purpose || typeof parsed.e !== 'number' || parsed.e < now) return null
    return parsed.d
  } catch {
    return null
  }
}
