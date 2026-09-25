// Номер сборки (ADR-011 §3): запись в данные и ветки принимается только от той же сборки хаба, что и сервер.
// Клиент и Worker выкладываются одним деплоем; номер клиента вшит в бандл, а Worker читает его из
// статики той же версии — /build.json, который пишет vite.config.ts. Так номер не нужно передавать в wrangler отдельно.
import type { Env } from './env'
import { json } from './http'

export const BUILD_HEADER = 'X-Hub-Build'
export const BUILD_ASSET = '/build.json'
const BUILD_ID = /^[0-9A-Za-z._-]{1,64}$/

let cached: string | undefined

/** Сбросить запомненный номер (тесты). */
export function resetBuildCache(): void {
  cached = undefined
}

/**
 * Какие запросы проверяют номер сборки: изменяющие запросы к данным и веткам.
 * Вход, выход и ключи не проверяются — иначе старая версия не смогла бы даже выйти.
 */
export function isGuardedWrite(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  return pathname === '/api/file' || pathname === '/api/commit' || pathname === '/api/branches' || pathname.startsWith('/api/branches/')
}

/** Номер сборки этого деплоя; null — статика без build.json (локальный запуск без сборки). */
export async function serverBuild(env: Env): Promise<string | null> {
  if (cached) return cached
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(BUILD_ASSET, env.APP_ORIGIN)))
    if (!res.ok) return null
    const body: unknown = await res.json()
    const build = (body as { build?: unknown } | null)?.build
    if (typeof build !== 'string' || !BUILD_ID.test(build)) return null
    cached = build
    return build
  } catch {
    return null
  }
}

/** Ответ 409 stale_build, если запрос на запись пришёл от другой сборки; иначе null. */
export async function checkBuild(request: Request, pathname: string, env: Env): Promise<Response | null> {
  if (!isGuardedWrite(request.method, pathname)) return null
  const build = await serverBuild(env)
  if (!build) {
    // Без номера сравнивать не с чем. В проде build.json есть всегда (его пишет сборка), так что это только локальный запуск.
    console.warn('build.json не найден: проверка номера сборки пропущена')
    return null
  }
  if (request.headers.get(BUILD_HEADER) === build) return null
  return json({ error: { code: 'stale_build', message: 'Хаб обновился: эта версия устарела и не сохраняет правки. Перезагрузи страницу.' } }, 409)
}
