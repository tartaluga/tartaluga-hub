// Коммиты по дням из status.json (ADR-015) для статистики. Данные из репо — недоверенный ввод: ключи и значения проверяются.
// Дни в status.json — по Москве; считаем их совпадающими с местными ключами хаба (localKey), владелец в Москве.
import type { Status } from '../schema/types'
import { projectStatus } from './widgets'

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
/** Больше 100 000 коммитов за день — битый или подделанный файл: такое число сожмёт пульс до нуля. */
const MAX_PER_DAY = 100_000

/** Коммиты репо проекта по дням. Мусорные ключи и значения (не целые, < 0, > MAX_PER_DAY) пропускаются. */
export function projectCommitDays(status: Status | null, slug: string): Map<string, number> {
  const out = new Map<string, number>()
  const byDay = projectStatus(status, slug)?.repo?.commitsByDay
  if (!byDay || typeof byDay !== 'object') return out
  for (const key of Object.keys(byDay)) {
    const n = byDay[key]
    if (DAY_KEY.test(key) && typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_PER_DAY) out.set(key, n)
  }
  return out
}

/** Сумма по дням для проектов; один репо (fullName без учёта регистра) считается один раз. */
export function commitDays(status: Status | null, slugs: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>()
  const seen = new Set<string>()
  const seenSlugs = new Set<string>()
  for (const slug of slugs) {
    if (seenSlugs.has(slug)) continue
    seenSlugs.add(slug)
    const repo = projectStatus(status, slug)?.repo
    if (!repo) continue
    const name = typeof repo.fullName === 'string' ? repo.fullName.toLowerCase() : ''
    if (name) {
      if (seen.has(name)) continue
      seen.add(name)
    }
    for (const [day, n] of projectCommitDays(status, slug)) out.set(day, (out.get(day) ?? 0) + n)
  }
  return out
}

/** Сумма по ключам в [start, end] включительно (ключи YYYY-MM-DD сравниваются как строки). */
export function sumDays(days: ReadonlyMap<string, number>, start: string, end: string): number {
  let sum = 0
  for (const [day, n] of days) if (day >= start && day <= end) sum += n
  return sum
}
