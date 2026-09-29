// Запись в репо данных и ветки (ADR-007). Каждый файл проверяется схемой, каждая запись несёт ожидаемую версию,
// сервер никогда не повторяет запись «поверх свежего sha» сам.
import { base64ToBytes } from '../src/lib/base64'
import { GitHubError, type FileChange, type GitHubClient } from '../src/lib/github'
import { parseFile } from '../src/data/model'
import type { Env } from './env'
import { dataRepo } from './githubApp'
import { assertRepoVisible, confirmGone, upstreamUnavailable } from './gone'
import { HttpError, json, readJson } from './http'
import { assertDataPath, assertSha, branchParam, isBranchName, isDataPath, MAIN, STATUS, writableBranch } from './rules'
import { isFresh, type Session } from './sessions'

const JSON_LIMIT = 1024 * 1024 // файл данных — до 1 МБ
const IMAGE_LIMIT = 2 * 1024 * 1024 // обложка — до 2 МБ
export const COMMIT_LIMIT = 100 // файлов в одном коммите (клиент: src/app/session.ts)
// Тело запроса коммита: до COMMIT_LIMIT JSON обычного размера (десятки КБ) и обложка в base64 (2 МБ → ~2,7 МБ).
// Картинки уходят в GitHub отдельным запросом каждая, а у Workers Free лимит 50 подзапросов на запрос.
// Текстовые файлы идут в одном запросе дерева, их число на подзапросы не влияет.
export const COMMIT_IMAGE_LIMIT = 20
export const COMMIT_BODY_LIMIT = 8 * 1024 * 1024
const MERGE_FILES_LIMIT = 300 // больше compare API не отдаёт — такое слияние делаем руками на GitHub

type F = typeof fetch | undefined

// ---------- Файлы ----------

/** Текст файла данных, проверенный схемой. Файл с незнакомыми полями проходит (они сохраняются как есть). */
function validatedText(path: string, text: unknown): string {
  if (typeof text !== 'string') throw new HttpError(400, 'bad_request', `${path}: нет текста файла`)
  if (new TextEncoder().encode(text).byteLength > JSON_LIMIT) throw new HttpError(413, 'payload_too_large', `${path}: файл больше 1 МБ`)
  const parsed = parseFile(path, '', text)
  if (!parsed.ok) throw new HttpError(422, 'validation', `${path}: ${parsed.error}`)
  if (parsed.readOnly) throw new HttpError(422, 'validation', `${path}: ${parsed.reason}`)
  if (parsed.idsAssigned) throw new HttpError(422, 'validation', `${path}: у элементов списков нет id`)
  return text
}

/** Картинка обложки: base64, до 2 МБ, и по содержимому действительно WebP или JPEG, как обещает расширение. */
function validatedImage(path: string, b64: unknown): Uint8Array {
  if (typeof b64 !== 'string') throw new HttpError(400, 'bad_request', `${path}: нет содержимого картинки`)
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(b64)
  } catch {
    throw new HttpError(400, 'bad_request', `${path}: картинка не в base64`)
  }
  if (bytes.byteLength > IMAGE_LIMIT) throw new HttpError(413, 'payload_too_large', `${path}: картинка больше 2 МБ`)
  const isWebp = bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (path.endsWith('.webp') ? !isWebp : !isJpeg) throw new HttpError(422, 'validation', `${path}: содержимое не совпадает с расширением`)
  return bytes
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))

/** PUT /api/file — создать или обновить один JSON-файл данных. sha — версия, с которой начиналась правка. */
export async function putFile(request: Request, env: Env, fetchImpl?: F): Promise<Response> {
  const body = await readJson<{ branch?: unknown; path?: unknown; text?: unknown; sha?: unknown }>(request, JSON_LIMIT * 2)
  const branch = writableBranch(body.branch)
  const path = assertDataPath(body.path)
  if (!path.endsWith('.json')) throw new HttpError(400, 'bad_request', 'Картинки сохраняются через /api/commit')
  const text = validatedText(path, body.text)
  const repo = await dataRepo(env, branch, fetchImpl)
  // 404 GitHub — «удалено» только после проверки (ADR-014). Создание не может «потерять» файл: там проверяется лишь ветка.
  const saved =
    body.sha === undefined || body.sha === null
      ? await confirmGone(repo, { branch }, () => repo.createFile(path, text, `Хаб: ${path}`))
      : await confirmGone(repo, { branch, path }, () => repo.updateFile(path, text, assertSha(typeof body.sha === 'string' ? body.sha : undefined), `Хаб: ${path}`))
  return json({ branch, path, sha: saved.sha })
}

/** POST /api/commit — несколько изменений одним атомарным коммитом. expectedHead обязателен. */
export async function commit(request: Request, env: Env, fetchImpl?: F): Promise<Response> {
  const body = await readJson<{ branch?: unknown; changes?: unknown; expectedHead?: unknown; message?: unknown }>(request, COMMIT_BODY_LIMIT)
  const branch = writableBranch(body.branch)
  const expectedHead = assertSha(typeof body.expectedHead === 'string' ? body.expectedHead : undefined)
  if (!Array.isArray(body.changes) || body.changes.length === 0) throw new HttpError(400, 'bad_request', 'Нет изменений')
  if (body.changes.length > COMMIT_LIMIT) throw new HttpError(413, 'payload_too_large', `Не больше ${COMMIT_LIMIT} файлов за раз`)

  const seen = new Set<string>()
  const changes: FileChange[] = body.changes.map((raw: unknown) => {
    const c = (raw ?? {}) as { path?: unknown; text?: unknown; base64?: unknown }
    const path = assertDataPath(c.path)
    if (seen.has(path)) throw new HttpError(400, 'bad_request', `${path}: дважды в одном коммите`)
    seen.add(path)
    const deleting = c.text === null || c.base64 === null
    if (deleting) return { path, content: null }
    return { path, content: path.endsWith('.json') ? validatedText(path, c.text) : validatedImage(path, c.base64) }
  })

  const images = changes.filter((c) => c.content instanceof Uint8Array).length
  if (images > COMMIT_IMAGE_LIMIT) throw new HttpError(413, 'payload_too_large', `Не больше ${COMMIT_IMAGE_LIMIT} картинок за раз`)

  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 200) : `Хаб: ${changes.length} файл(ов)`
  const repo = await dataRepo(env, branch, fetchImpl)
  const result = await confirmGone(repo, { branch }, () => repo.commitFiles(changes, message, expectedHead))
  return json({ branch, head: result.commitSha, shas: result.shas })
}

// ---------- Ветки ----------

/** GET /api/branches */
export async function listBranches(env: Env, fetchImpl?: F): Promise<Response> {
  const repo = await dataRepo(env, MAIN, fetchImpl)
  const branches = await repo.listBranches()
  return json({
    branches: branches
      .filter((b) => isBranchName(b.name)) // ветки с другими именами хаб не трогает
      .map((b) => ({ name: b.name, head: b.sha, main: b.name === MAIN, service: b.name === STATUS })),
  })
}

/** Ветку, созданную или изменённую хабом: не main и не status. */
function userBranch(name: string | undefined): string {
  if (!name) throw new HttpError(400, 'bad_request', 'Нужно имя ветки')
  const branch = branchParam(name)
  if (branch === MAIN || branch === STATUS) throw new HttpError(403, 'forbidden', `С веткой ${branch} так нельзя`)
  return branch
}

/** POST /api/branches — {name}: новая ветка от текущего main. */
export async function createBranch(request: Request, env: Env, fetchImpl?: F): Promise<Response> {
  const body = await readJson<{ name?: unknown }>(request, 1024)
  const name = userBranch(typeof body.name === 'string' ? body.name : undefined)
  const repo = await dataRepo(env, MAIN, fetchImpl)
  const head = await repo.branchHead(MAIN)
  await repo.createBranch(name, head)
  return json({ name, head }, 201)
}

/**
 * DELETE /api/branches/:name — только при свежем входе. Ветки уже нет (подтверждено, ADR-014) — тоже успех:
 * цель «ветки нет» достигнута, а клиент после успеха забывает её кэш.
 */
export async function deleteBranch(name: string, session: Session, now: number, env: Env, fetchImpl?: F): Promise<Response> {
  const branch = userBranch(name)
  requireFresh(session, now)
  const repo = await dataRepo(env, MAIN, fetchImpl)
  try {
    await confirmGone(repo, { branch }, () => repo.deleteBranch(branch))
  } catch (e) {
    if (e instanceof HttpError && e.code === 'branch_not_found') return json({ ok: true, alreadyGone: true })
    throw e
  }
  return json({ ok: true })
}

/**
 * POST /api/branches/:name/merge — влить ветку в main.
 * В ветку мог писать Claude-скилл напрямую через git, минуя проверки, поэтому перед слиянием сервер
 * проверяет каждый изменённый файл. Файлы вне разрешённых путей (например, .github/) — отказ.
 */
export async function mergeBranch(name: string, env: Env, fetchImpl?: F): Promise<Response> {
  const branch = userBranch(name)
  const repo = await dataRepo(env, MAIN, fetchImpl)
  // Проверяем и вливаем один и тот же коммит: если в ветку допишут между проверкой и слиянием, непроверенное не попадёт в main.
  const head = await confirmGone(repo, { branch }, () => repo.branchHead(branch))
  const diff = await repo.compare(MAIN, head)
  if (diff.aheadBy === 0) return json({ merged: false, reason: 'nothing_to_merge' })
  if (diff.files.length >= MERGE_FILES_LIMIT) throw new HttpError(422, 'validation', 'Слишком много изменённых файлов, слей ветку на GitHub')

  const problems: { path: string; error: string }[] = []
  const checked = new Map<string, string>() // путь → sha проверенного содержимого из ветки
  for (const f of diff.files) {
    const outside = [f.path, f.previousPath].filter((p): p is string => p !== undefined && !isDataPath(p))
    if (outside.length) {
      for (const p of outside) problems.push({ path: p, error: 'хаб не вливает файлы вне данных' })
      continue
    }
    if (f.status === 'removed' || !f.path.endsWith('.json')) continue
    const parsed = parseFile(f.path, f.sha, await repo.readBlobText(f.sha))
    if (!parsed.ok) problems.push({ path: f.path, error: parsed.error })
    else checked.set(f.path, f.sha)
  }
  if (problems.length) throw new HttpError(422, 'validation', 'В ветке есть файлы, которые не проходят проверку', { files: problems })

  const oldMain = await repo.branchHead(MAIN)
  let sha: string | null
  try {
    sha = await repo.merge(MAIN, head, `Хаб: влить ${branch} в ${MAIN}`)
  } catch (e) {
    if (e instanceof GitHubError && e.kind === 'conflict') {
      throw new HttpError(409, 'conflict', 'Ветка конфликтует с main', { files: diff.files.map((f) => f.path) })
    }
    throw e
  }
  if (sha === null) return json({ merged: false, head: null })
  const { warnings, checkFailed } = await checkMergeResult(repo, oldMain, sha, checked)
  return json({ merged: true, head: sha, ...(warnings.length ? { warnings } : {}), ...(checkFailed ? { checkFailed: true } : {}) })
}

/**
 * Проверка итога слияния (ADR-010 §3.6): merge API склеивает построчно, и файл, который правили и в ветке,
 * и в main, может выйти неверным, хотя обе стороны по отдельности верны. Откатить main без force нельзя,
 * поэтому ошибки не отменяют слияние, а возвращаются предупреждениями — экран просит проверить файл.
 * Файлы, чьё итоговое содержимое совпало с проверенным в ветке, повторно не читаются.
 */
async function checkMergeResult(repo: GitHubClient, oldMain: string, newMain: string, checked: Map<string, string>): Promise<{ warnings: { path: string; error: string }[]; checkFailed: boolean }> {
  const warnings: { path: string; error: string }[] = []
  try {
    const diff = await repo.compare(oldMain, newMain)
    for (const f of diff.files) {
      if (f.status === 'removed' || !f.path.endsWith('.json') || checked.get(f.path) === f.sha) continue
      const parsed = parseFile(f.path, f.sha, await repo.readBlobText(f.sha))
      if (!parsed.ok) warnings.push({ path: f.path, error: parsed.error })
    }
  } catch (e) {
    // Слияние уже в main: сбой проверки — флаг в ответе, а не ошибка запроса.
    console.error('merge result check failed', e instanceof GitHubError ? e.kind : e instanceof Error ? e.name : typeof e)
    return { warnings, checkFailed: true }
  }
  return { warnings, checkFailed: false }
}

/** POST /api/status/refresh — запустить status.yml только на main (на другой ветке могла лежать старая версия). */
/**
 * POST /api/status/refresh — «Обновить сейчас» (ADR-015 п.2): workflow_dispatch для status.yml на main.
 * Тело запроса не читается: ветку и входы задаёт сервер. 204 → 202; 404 — «не настроено» только при видимом репо
 * (ADR-014); 403 (нет права или запуск запрещён) и 5xx — временная ошибка, клиент ничего не меняет.
 */
export async function refreshStatus(env: Env, fetchImpl?: F): Promise<Response> {
  const repo = await dataRepo(env, MAIN, fetchImpl)
  try {
    await repo.dispatchWorkflow('status.yml', MAIN)
  } catch (e) {
    if (e instanceof GitHubError && e.kind === 'not_found') {
      await assertRepoVisible(repo) // 404 и когда токен не видит репо (ADR-014)
      throw new HttpError(404, 'not_found', 'Проверка виджетов не настроена')
    }
    if (e instanceof GitHubError && (e.kind === 'forbidden' || e.kind === 'server' || e.kind === 'network')) {
      console.error('status dispatch failed', e.kind, e.status)
      throw upstreamUnavailable()
    }
    throw e
  }
  return json({ ok: true }, 202)
}

export function requireFresh(session: Session, now: number): void {
  if (!isFresh(session, now)) throw new HttpError(403, 'fresh_login_required', 'Подтверди вход ещё раз')
}
