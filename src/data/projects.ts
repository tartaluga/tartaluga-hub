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
}

const DAY = 24 * 60 * 60 * 1000

/** Сколько календарных дней от today до due: 0 — сегодня, -2 — просрочено на 2 дня. */
export function daysUntil(due: string, today: Date): number {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((parseLocalDate(due).getTime() - start.getTime()) / DAY)
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

  for (const f of files) {
    const parsed = parseFile(f.path, f.sha, f.text)
    if (!parsed.ok) {
      broken.push({ path: f.path, error: parsed.error })
      if (f.path === 'settings.json') settingsProblem = `settings.json не читается: ${parsed.error}`
      continue
    }
    if (parsed.kind === 'settings') {
      tags = (parsed.data as Settings).tags
      settingsProblem = null
    } else if (parsed.kind === 'project') {
      const data = parsed.data as WithUnknown<Project>
      const tasks = data.tasks ?? []
      const done = tasks.filter((t) => t.done).length
      projects.push({
        path: f.path,
        data,
        readOnly: parsed.readOnly,
        progress: tasks.length ? done / tasks.length : null,
        tasksDone: done,
        tasksTotal: tasks.length,
        deadline: deadlineOf(data, today),
      })
    }
  }
  return { projects, broken: broken.sort((a, b) => a.path.localeCompare(b.path)), tags, settingsProblem }
}

// ---------- Фильтры ----------

export type SortKey = 'updated' | 'title' | 'deadline' | 'progress'

export const SORT_LABEL: Record<SortKey, string> = {
  updated: 'по изменению',
  title: 'по названию',
  deadline: 'по сроку',
  progress: 'по прогрессу',
}

export interface Filter {
  query: string
  /** Пусто — все статусы, кроме архива. */
  statuses: Status[]
  /** Проект подходит, если у него есть хотя бы один из выбранных тегов. */
  tags: string[]
  sort: SortKey
}

export const EMPTY_FILTER: Filter = { query: '', statuses: [], tags: [], sort: 'updated' }

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
    case 'updated':
      return Date.parse(b.data.updatedAt) - Date.parse(a.data.updatedAt)
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
    sort: sort && sort in SORT_LABEL ? (sort as SortKey) : 'updated',
  }
}

export function filterToParams(f: Filter): URLSearchParams {
  const p = new URLSearchParams()
  if (f.query) p.set('q', f.query)
  for (const s of f.statuses) p.append('status', s)
  for (const t of f.tags) p.append('tag', t)
  if (f.sort !== 'updated') p.set('sort', f.sort)
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
