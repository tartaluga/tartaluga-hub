// «Удалено» только подтверждённое (ADR-014). 404 GitHub неоднозначен: нет ветки, нет файла — или токен установки
// больше не видит репо данных. По ответу «удалено» клиент стирает очередь ветки или отдаёт правку в конфликты,
// поэтому сервер говорит «удалено», только проверив, что репо читается этим же токеном.
// Доп. запросы — только на пути 404 и не больше трёх (у Workers Free лимит 50 подзапросов на запрос).
import { GitHubError, type GitHubClient } from '../src/lib/github'
import { HttpError } from './http'

/** Что должно было существовать: ветка; файл в ветке; объект (blob) по sha. */
export type Target = { branch: string; path?: string } | { blob: string }

/** GitHub не подтвердил ни наличие, ни отсутствие: клиент повторяет позже, ничего не стирая. */
export const upstreamUnavailable = () => new HttpError(503, 'upstream_unavailable', 'GitHub сейчас не подтверждает данные — повторю позже')

export const branchNotFound = () => new HttpError(404, 'branch_not_found', 'Ветки нет в репо данных')

const isNotFound = (e: unknown) => e instanceof GitHubError && e.kind === 'not_found'

/** Выполнить обращение к GitHub; его 404 превращается в подтверждённое «нет ветки/файла» или во временную ошибку. */
export async function confirmGone<T>(repo: GitHubClient, target: Target, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (!isNotFound(e)) throw e
    throw await explain(repo, target)
  }
}

/** Проверить, что репо данных читается этим токеном; иначе — временная ошибка. */
export async function assertRepoVisible(repo: GitHubClient): Promise<void> {
  try {
    await repo.checkAccess()
  } catch {
    throw upstreamUnavailable()
  }
}

async function explain(repo: GitHubClient, target: Target): Promise<HttpError> {
  try {
    if ('blob' in target) {
      // Объект по sha не меняется: репо видно — значит, такого объекта нет.
      await assertRepoVisible(repo)
      return new HttpError(404, 'not_found', 'Нет такого содержимого в репо данных')
    }
    // Проверка репо — последней: доступ, пропавший между запросами, не превратится в «удалено».
    if (!(await branchExists(repo, target.branch))) {
      await assertRepoVisible(repo)
      return branchNotFound()
    }
    // Ветка есть, а 404 не про файл (или файл не спрашивали) — ответ GitHub не объяснён.
    if (target.path === undefined || (await repo.fileExists(target.path, target.branch))) return upstreamUnavailable()
    await assertRepoVisible(repo)
    return new HttpError(404, 'not_found', 'Файла нет в ветке')
  } catch (e) {
    if (e instanceof HttpError) return e
    console.error('confirm gone failed', e instanceof GitHubError ? e.kind : e instanceof Error ? e.name : typeof e)
    return upstreamUnavailable()
  }
}

async function branchExists(repo: GitHubClient, branch: string): Promise<boolean> {
  try {
    await repo.branchHead(branch)
    return true
  } catch (e) {
    if (isNotFound(e)) return false
    throw e
  }
}
