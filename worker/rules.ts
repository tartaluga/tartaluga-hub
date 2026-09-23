// Что сервер разрешает трогать в репо данных (ADR-007). Всё, что не подходит, — отказ.
import { HttpError } from './http'

// Путь проверяется целиком: никаких «..», «%2e», «.github/». slug и ULID — те же, что в schema/defs.schema.json.
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*'
const DATA_PATH = new RegExp(`^(?:projects/(${SLUG})\\.json|ideas/[0-9A-HJKMNP-TV-Z]{26}\\.json|settings\\.json|covers/(${SLUG})\\.(?:webp|jpg))$`)

export function isDataPath(path: string): boolean {
  const m = DATA_PATH.exec(path)
  const slug = m?.[1] ?? m?.[2]
  return m !== null && (slug === undefined || slug.length <= 64)
}

export function assertDataPath(path: unknown): string {
  if (typeof path !== 'string' || !isDataPath(path)) throw new HttpError(400, 'bad_request', 'Этот путь хаб не пишет')
  return path
}

const BRANCH = /^[a-z0-9][a-z0-9-]{0,39}$/
export const MAIN = 'main'
export const STATUS = 'status'

/** Имя ветки из параметра; без параметра — main. */
export function branchParam(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MAIN
  if (!BRANCH.test(value)) throw new HttpError(400, 'bad_request', 'Недопустимое имя ветки')
  return value
}

/** Ветка, в которую можно писать: не status (её пишет только Action). */
export function writableBranch(value: unknown): string {
  if (value !== undefined && typeof value !== 'string') throw new HttpError(400, 'bad_request', 'Недопустимое имя ветки')
  const branch = branchParam(value)
  if (branch === STATUS) throw new HttpError(403, 'forbidden', 'Ветка status только для чтения')
  return branch
}

export function assertSha(sha: string | undefined): string {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, 'bad_request', 'Неверный sha')
  return sha
}
