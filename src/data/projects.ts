// Проекты для экранов: разбор файлов из кэша ветки, прогресс, ближайший дедлайн, фильтры и сортировка.
// Всё здесь — чистые функции: на входе файлы и «сегодня», на выходе то, что рисуют плитки.
import type { CachedFile } from '../lib/localdb'
import type { Project, Settings, Tag } from '../schema/types'
import { parseFile, parseLocalDate, type WithUnknown } from './model'

export type Status = Project['status']

export const STATUSES: Status[] = ['idea', 'active', 'paused', 'done', 'archived']

export const STATUS_LABEL: Record<Status, string> = {
  idea: 'идея',
  active: 'в работе',
  paused: 'пауза',
  done: 'готово',
  archived: 'архив',
}

export interface ProjectView {
  path: string
  data: WithUnknown<Project>
  readOnly: boolean
  /** Доля закрытых задач, 0..1. null — задач нет. */
  progress: number | null
  tasksDone: number
  tasksTotal: number
  /** Ближайший срок среди открытых задач и незакрытых вех. */
  deadline: { due: string; days: number; title: string } | null
  /** Последняя активность: последняя запись лога, без лога — последняя правка файла. */
  activityAt: number
  /** Сколько календарных дней назад была активность (0 — сегодня). */
  activityDays: number
  /** «N дн тишины»: проект в работе, а в логе нет записей дольше порога из settings.json. Иначе null. */
  silentDays: number | null
}

export interface BrokenFile {
  path: string
  error: string
}

export interface Library {
  projects: ProjectView[]
  broken: BrokenFile[]
  tags: Tag[]
  /** settings.json отсутствует или не читается — теги недоступны. */
  settingsProblem: string | null
  /** Порог «заброшенности» в днях (settings.abandonedAfterDays, по умолчанию 14). */
  abandonedAfterDays: number
}

const DAY = 24 * 60 * 60 * 1000

/** Сколько календарных дней от today до due: 0 — сегодня, -2 — просрочено на 2 дня. */
export function daysUntil(due: string, today: Date): number {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((parseLocalDate(due).getTime() - start.getTime()) / DAY)
}

/** Сколько календарных дней прошло от момента at (мс) до today: 0 — сегодня, 1 — вчера. */
export function daysSince(at: number, today: Date): number {
  const d = new Date(at)
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const b = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return Math.round((b - a) / DAY)
}

/** Подпись активности на плитке: «сегодня», «вчера», «4 дн». */
export function activityText(days: number): string {
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'вчера'
  return `${days} дн`
}

export const DEFAULT_ABANDONED_DAYS = 14

function activityOf(p: Project, today: Date, abandonedAfter: number) {
  const logTimes = (p.log ?? []).map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t))
  const lastLog = logTimes.length ? Math.max(...logTimes) : null
  const updated = Date.parse(p.updatedAt)
  const activityAt = lastLog ?? (Number.isNaN(updated) ? 0 : updated)
  // Тишина считается по логу, как «заброшенные» на экране «Сегодня»; проект без лога — от даты создания.
  const since = lastLog ?? Date.parse(p.createdAt)
  const quiet = Number.isNaN(since) ? 0 : daysSince(since, today)
  return {
    activityAt,
    activityDays: Math.max(0, daysSince(activityAt, today)),
    silentDays: p.status === 'active' && quiet > abandonedAfter ? quiet : null,
  }
}

function deadlineOf(p: Project, today: Date): ProjectView['deadline'] {
  const tasks = p.tasks ?? []
  const candidates: { due: string; title: string }[] = []
  for (const t of tasks) if (!t.done && t.due) candidates.push({ due: t.due, title: t.title })
  for (const m of p.milestones ?? []) {
    if (!m.due) continue
    const own = tasks.filter((t) => t.milestoneId === m.id)
    // Веха без задач или с открытыми задачами ещё в работе; веха, где всё сделано, сроком не грозит.
    if (own.length === 0 || own.some((t) => !t.done)) candidates.push({ due: m.due, title: m.title })
  }
  if (!candidates.length) return null
  const first = candidates.reduce((a, b) => (b.due < a.due ? b : a))
  return { ...first, days: daysUntil(first.due, today) }
}

export function buildLibrary(files: CachedFile[], today: Date): Library {
  const projects: ProjectView[] = []
  const broken: BrokenFile[] = []
  let tags: Tag[] = []
  let settingsProblem: string | null = 'Нет файла settings.json — теги не заданы'
  let abandonedAfterDays = DEFAULT_ABANDONED_DAYS
  const parsedProjects: { path: string; data: WithUnknown<Project>; readOnly: boolean }[] = []

  for (const f of files) {
    const parsed = parseFile(f.path, f.sha, f.text)
    if (!parsed.ok) {
      broken.push({ path: f.path, error: parsed.error })
      if (f.path === 'settings.json') settingsProblem = `settings.json не читается: ${parsed.error}`
      continue
    }
    if (parsed.kind === 'settings') {
      const settings = parsed.data as Settings
      tags = settings.tags
      abandonedAfterDays = settings.abandonedAfterDays ?? DEFAULT_ABANDONED_DAYS
      settingsProblem = null
    } else if (parsed.kind === 'project') {
      parsedProjects.push({ path: f.path, data: parsed.data as WithUnknown<Project>, readOnly: parsed.readOnly })
    }
  }
  // Проекты считаем после settings.json: порог тишины берётся оттуда, а порядок файлов в кэше любой.
  for (const { path, data, readOnly } of parsedProjects) {
    const tasks = data.tasks ?? []
    const done = tasks.filter((t) => t.done).length
    projects.push({
      path,
      data,
      readOnly,
      progress: tasks.length ? done / tasks.length : null,
      tasksDone: done,
      tasksTotal: tasks.length,
      deadline: deadlineOf(data, today),
      ...activityOf(data, today, abandonedAfterDays),
    })
  }
  return { projects, broken: broken.sort((a, b) => a.path.localeCompare(b.path)), tags, settingsProblem, abandonedAfterDays }
}

// ---------- Фильтры ----------

export type SortKey = 'activity' | 'title' | 'deadline' | 'progress'

export const SORT_LABEL: Record<SortKey, string> = {
  activity: 'по последней активности',
  title: 'по названию',
  deadline: 'по сроку',
  progress: 'по прогрессу',
}

export interface Filter {
  query: string
  /** Пусто — все статусы, кроме архива. На экране выбирается один статус, но формат допускает несколько. */
  statuses: Status[]
  /** Проект подходит, если у него есть хотя бы один из выбранных тегов. */
  tags: string[]
  sort: SortKey
}

export const EMPTY_FILTER: Filter = { query: '', statuses: [], tags: [], sort: 'activity' }

const norm = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е')

function matchesQuery(p: Project, q: string): boolean {
  if (!q) return true
  const hay = [p.title, p.slug, p.nextStep ?? '', p.description ?? '', ...(p.stack ?? [])].map(norm).join('\n')
  return norm(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

function compare(sort: SortKey, a: ProjectView, b: ProjectView): number {
  switch (sort) {
    case 'title':
      return collator.compare(a.data.title, b.data.title)
    case 'deadline': {
      // Без срока — в конец.
      const da = a.deadline?.due ?? '9999-99-99'
      const db = b.deadline?.due ?? '9999-99-99'
      return da < db ? -1 : da > db ? 1 : 0
    }
    case 'progress':
      // Без задач — в конец; дальше по убыванию прогресса.
      return (b.progress ?? -1) - (a.progress ?? -1)
    case 'activity':
      return b.activityAt - a.activityAt
  }
}

export function applyFilter(projects: ProjectView[], f: Filter): ProjectView[] {
  const statuses = new Set<Status>(f.statuses.length ? f.statuses : STATUSES.filter((s) => s !== 'archived'))
  const tags = new Set(f.tags)
  return projects
    .filter((p) => statuses.has(p.data.status))
    .filter((p) => tags.size === 0 || (p.data.tags ?? []).some((t) => tags.has(t)))
    .filter((p) => matchesQuery(p.data, f.query.trim()))
    .sort((a, b) => compare(f.sort, a, b) || collator.compare(a.data.title, b.data.title))
}

// Фильтр живёт в адресе (#/projects?q=…&status=…&tag=…&sort=…), чтобы «назад» из карточки его не сбрасывал.

export function filterFromParams(params: URLSearchParams): Filter {
  const sort = params.get('sort')
  return {
    query: params.get('q') ?? '',
    statuses: params.getAll('status').filter((s): s is Status => (STATUSES as string[]).includes(s)),
    tags: params.getAll('tag'),
    sort: sort && sort in SORT_LABEL ? (sort as SortKey) : 'activity',
  }
}

export function filterToParams(f: Filter): URLSearchParams {
  const p = new URLSearchParams()
  if (f.query) p.set('q', f.query)
  for (const s of f.statuses) p.append('status', s)
  for (const t of f.tags) p.append('tag', t)
  if (f.sort !== 'activity') p.set('sort', f.sort)
  return p
}

/** Подпись срока: «-2 дн · 21.09», «сегодня», «завтра», «26.09». */
export function deadlineText(d: { due: string; days: number }): string {
  const [, m, day] = d.due.split('-')
  if (d.days < 0) return `−${-d.days} дн · ${day}.${m}`
  if (d.days === 0) return 'сегодня'
  if (d.days === 1) return 'завтра'
  return `${day}.${m}`
}

/** Горит: просрочено или срок в ближайшие 3 дня (как на экране «Сегодня»). */
export const isHot = (d: { days: number }) => d.days <= 3

/** Сколько проектов в каждом статусе — для переключателя «Все · В работе · …». */
export function countByStatus(projects: ProjectView[]): Record<Status, number> {
  const counts = { idea: 0, active: 0, paused: 0, done: 0, archived: 0 }
  for (const p of projects) counts[p.data.status]++
  return counts
}
