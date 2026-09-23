// Доступ сервера к репо данных через GitHub App (ADR-007):
// JWT RS256 ключом приложения → токен установки на 1 час, только на репо данных и только с нужными правами.
import { base64ToBytes } from '../src/lib/base64'
import { GitHubClient } from '../src/lib/github'
import { base64url } from './crypto'
import type { Env } from './env'
import { HttpError } from './http'

export const USER_AGENT = 'tartaluga-hub'

// ---------- Ключ: PEM → CryptoKey ----------

/** GitHub выдаёт ключ в PKCS#1 («BEGIN RSA PRIVATE KEY»), WebCrypto понимает только PKCS#8. Переупаковываем сами. */
export function pemToPkcs8(pem: string): Uint8Array {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem)
  if (!m || Boolean(m[1]) !== Boolean(m[3])) throw new Error('Ключ GitHub App не похож на PEM')
  const der = base64ToBytes(m[2]!)
  return m[1] ? wrapPkcs1(der) : der
}

// PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, algorithm SEQUENCE { rsaEncryption, NULL }, privateKey OCTET STRING }
const RSA_ALGORITHM_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]

function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const octet = derNode(0x04, pkcs1)
  return derNode(0x30, concat([new Uint8Array([0x02, 0x01, 0x00]), new Uint8Array(RSA_ALGORITHM_ID), octet]))
}

function derNode(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length
  let header: number[]
  if (len < 0x80) header = [tag, len]
  else {
    const bytes: number[] = []
    for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff)
    header = [tag, 0x80 | bytes.length, ...bytes]
  }
  return concat([new Uint8Array(header), content])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

let keyCache: { pem: string; key: Promise<CryptoKey> } | null = null
function signingKey(pem: string): Promise<CryptoKey> {
  if (keyCache?.pem !== pem) {
    const key = crypto.subtle.importKey('pkcs8', pemToPkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    key.catch(() => (keyCache = null))
    keyCache = { pem, key }
  }
  return keyCache.key
}

/** JWT приложения: iat на 60 с в прошлом (часы GitHub могут спешить), срок 9 минут (GitHub допускает до 10). */
export async function appJwt(env: Pick<Env, 'GITHUB_APP_CLIENT_ID' | 'GITHUB_APP_PRIVATE_KEY'>, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60
  const enc = (o: object) => base64url(new TextEncoder().encode(JSON.stringify(o)))
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 600 - 60, iss: env.GITHUB_APP_CLIENT_ID })}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(env.GITHUB_APP_PRIVATE_KEY), new TextEncoder().encode(input))
  return `${input}.${base64url(new Uint8Array(sig))}`
}

// ---------- Токен установки ----------

let tokenCache: { token: string; expiresAt: number } | null = null
let pending: Promise<string> | null = null

/** Токен установки из кэша изолята; перевыпускается за 10 минут до конца срока. */
export function installationToken(env: Env, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - 10 * 60_000 > now) return Promise.resolve(tokenCache.token)
  pending ??= issueToken(env, fetchImpl).finally(() => (pending = null))
  return pending
}

async function issueToken(env: Env, fetchImpl: typeof fetch): Promise<string> {
  const jwt = await appJwt(env)
  const res = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    // Сужаем токен ещё сильнее, чем установка: только репо данных и только эти права.
    body: JSON.stringify({ repositories: [env.DATA_REPO], permissions: { contents: 'write', actions: 'write', metadata: 'read' } }),
  })
  if (!res.ok) {
    console.error('installation token failed', res.status)
    throw new HttpError(502, 'upstream', 'Сервер не смог получить доступ к репо данных')
  }
  const body = (await res.json()) as { token: string; expires_at: string; repositories?: { name: string }[] }
  const repos = body.repositories?.map((r) => r.name) ?? []
  if (repos.length !== 1 || repos[0] !== env.DATA_REPO) {
    // Защита от ошибки настройки: токен обязан видеть ровно одно репо — данные.
    console.error('installation token has unexpected repositories', repos.length)
    throw new HttpError(502, 'upstream', 'Доступ сервера настроен неверно')
  }
  tokenCache = { token: body.token, expiresAt: Date.parse(body.expires_at) }
  return body.token
}

/** Для тестов. */
export function resetGitHubAppCaches(): void {
  keyCache = null
  tokenCache = null
  pending = null
}

/** Клиент репо данных для одной ветки. */
export async function dataRepo(env: Env, branch: string, fetchImpl: typeof fetch = fetch): Promise<GitHubClient> {
  return new GitHubClient({
    token: await installationToken(env, fetchImpl),
    owner: env.DATA_OWNER,
    repo: env.DATA_REPO,
    branch,
    userAgent: USER_AGENT,
    fetch: fetchImpl,
  })
}
