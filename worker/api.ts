// Смысловые команды к репо данных (ADR-007). Браузер не может составить произвольный запрос к GitHub.
import { bytesToBase64 } from '../src/lib/base64'
import type { Env } from './env'
import { dataRepo } from './githubApp'
import { assertRepoVisible, confirmGone } from './gone'
import { HttpError, json } from './http'
import { assertSha, branchParam, isDataPath, STATUS } from './rules'

/** GET /api/files?branch= — файлы данных ветки одним запросом: пути, sha, head. */
export async function listFiles(url: URL, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
  const branch = branchParam(url.searchParams.get('branch'))
  const repo = await dataRepo(env, branch, fetchImpl)
  const { commitSha, files } = await confirmGone(repo, { branch }, () => repo.listFiles())
  return json({ branch, head: commitSha, files: files.filter((f) => isDataPath(f.path)) })
}

/** GET /api/blob/:sha — содержимое файла по sha, внутри JSON (не «как есть»: файл из репо не выполнится на нашем адресе). */
export async function readBlob(sha: string | undefined, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
  const repo = await dataRepo(env, 'main', fetchImpl)
  const blob = assertSha(sha)
  const bytes = await confirmGone(repo, { blob }, () => repo.readBlob(blob))
  return json({ sha, base64: bytesToBase64(bytes) })
}

/** GET /api/status — status.json из ветки status (живые виджеты), только чтение. */
export async function readStatus(env: Env, fetchImpl?: typeof fetch): Promise<Response> {
  const repo = await dataRepo(env, STATUS, fetchImpl)
  const file = await repo.readFile('status.json')
  if (!file) {
    // readFile даёт null на любой 404 — в том числе когда токен не видит репо (ADR-014).
    await assertRepoVisible(repo)
    throw new HttpError(404, 'not_found', 'Виджеты ещё не собирались')
  }
  return json({ sha: file.sha, text: file.text })
}
