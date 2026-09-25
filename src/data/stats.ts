// Экран «Статистика» (макет 2c): период, лог, закрытые задачи, дедлайны, активность по проектам, опубликованное.
// Чистые функции поверх buildLibrary. «Сегодня» всегда приходит параметром; моменты из файлов переводятся
// в местную дату (как в today.ts), календарные даты YYYY-MM-DD сравниваются строками.
// Коммиты здесь не считаются: они появятся с виджетами репо (ADR-005), выдумывать их нельзя.
import type { Task } from '../schema/types'
import { firstDue } from './model'
import type { ProjectView, Status } from './projects'
import { localKey, pulseLevel } from './today'

// ---------- Период ----------

export type Period = 'month' | 'quarter' | 'half'

export const PERIODS: Period[] = ['month', 'quarter', 'half']

export const PERIOD_LABEL: Record<Period, string> = { month: 'Месяц', quarter: 'Квартал', half: 'Полгода' }

const PERIOD_MONTHS: Record<Period, number> = { month: 1, quarter: 3, half: 6 }

export function isPeriod(v: unknown): v is Period {
  return typeof v === 'string' && (PERIODS as string[]).includes(v)
}

/** Период включительно с обеих сторон: местные даты YYYY-MM-DD. */
export interface Range {
  start: string
  end: string
}

/**
 * Тот же день N месяцев назад — сегодня: квартал от 23.09 — это 23.06–23.09.
 * Если такого дня в месяце нет (31.05 − 3 мес.), берётся последний день месяца, а не перескок в следующий.
 */
export function periodRange(period: Period, today: Date): Range {
  const y = today.getFullYear()
  const m = today.getMonth() - PERIOD_MONTHS[period]
  const last = new Date(y, m + 1, 0).getDate()
  const start = new Date(y, m, Math.min(today.getDate(), last))
  return { start: localKey(start), end: localKey(today) }
}

const dm = (key: string) => `${key.slice(8, 10)}.${key.slice(5, 7)}`

/** Надзаголовок: «23.06 — 23.09.2026»; через границу года — год у обеих дат. */
export function rangeLabel(r: Range): string {
  const sy = r.start.slice(0, 4)
  const ey = r.end.slice(0, 4)
  return sy === ey ? `${dm(r.start)} — ${dm(r.end)}.${ey}` : `${dm(r.start)}.${sy} — ${dm(r.end)}.${ey}`
}

export const inRange = (key: string, r: Range) => key >= r.start && key <= r.end

/** Местная дата момента ISO 8601; нечитаемый момент — null. */
export function dayOf(at: string | undefined): string | null {
  if (!at) return null
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : localKey(new Date(t))
}

// ---------- Счётчики ----------

/** Записи лога за период по всем проектам, архив тоже: это история, а не список дел. */
export function logCount(projects: ProjectView[], r: Range): number {
  let n = 0
  for (const p of projects) for (const e of p.data.log ?? []) if (isIn(dayOf(e.at), r)) n++
  return n
}

/** Задачи, закрытые за период. Закрытые без doneAt (правка мимо хаба) не датированы и не считаются. */
export function tasksClosed(projects: ProjectView[], r: Range): number {
  let n = 0
  for (const p of projects) for (const t of p.data.tasks ?? []) if (t.done && isIn(dayOf(t.doneAt), r)) n++
  return n
}

const isIn = (key: string | null, r: Range) => key !== null && inRange(key, r)

// ---------- Дедлайны ----------

export type Outcome = 'onTime' | 'moved' | 'missed'

export const OUTCOMES: Outcome[] = ['onTime', 'moved', 'missed']

export const OUTCOME_LABEL: Record<Outcome, string> = { onTime: 'в срок', moved: 'перенесено', missed: 'сорвано' }

/**
 * Итог срока задачи и день, к которому он относится; null — срока нет или итог ещё не ясен.
 * Первый срок — originalDue ?? due (ADR-009). «Перенесено» — только перенос на более поздний день.
 * - закрыта не позже первого срока — в срок (день закрытия);
 * - закрыта после первого, но не позже перенесённого — перенесено (день закрытия);
 * - закрыта позже текущего срока — сорвано (день закрытия), в том числе если срок передвинули раньше;
 * - закрыта без doneAt — итог не ясен: неизвестно, когда;
 * - открыта, текущий срок прошёл — сорвано (день срока);
 * - открыта, срок перенесён и ещё не прошёл — перенесено (первый срок, но не позже сегодня);
 * - открыта, срок не переносился и не прошёл — ещё впереди.
 */
export function taskOutcome(task: Pick<Task, 'done' | 'due' | 'originalDue' | 'doneAt'>, todayKey: string): { outcome: Outcome; day: string } | null {
  const first = firstDue(task)
  if (!first) return null
  const due = task.due ?? first
  const movedLater = due > first
  if (task.done) {
    const day = dayOf(task.doneAt)
    if (!day) return null
    if (day > due) return { outcome: 'missed', day }
    return { outcome: day <= first ? 'onTime' : 'moved', day }
  }
  if (due < todayKey) return { outcome: 'missed', day: due }
  if (movedLater) return { outcome: 'moved', day: first < todayKey ? first : todayKey }
  return null
}

export interface Deadlines {
  counts: Record<Outcome, number>
  total: number
  /** Доля «в срок», 0..1; null — за период не решился ни один срок. */
  onTimeShare: number | null
}

/** Итоги сроков задач, день которых попал в период. У вех своего итога нет: он складывается из задач. */
export function deadlines(projects: ProjectView[], r: Range): Deadlines {
  const counts: Record<Outcome, number> = { onTime: 0, moved: 0, missed: 0 }
  for (const p of projects) {
    for (const t of p.data.tasks ?? []) {
      const res = taskOutcome(t, r.end)
      if (res && inRange(res.day, r)) counts[res.outcome]++
    }
  }
  const total = counts.onTime + counts.moved + counts.missed
  return { counts, total, onTimeShare: total ? counts.onTime / total : null }
}

/** «78%» или «—», если считать не из чего. */
export function percentText(share: number | null): string {
  return share === null ? '—' : `${Math.round(share * 100)}%`
}

// ---------- Активность по проектам ----------

export interface ProjectActivity {
  slug: string
  title: string
  status: Status
  count: number
  /** Доля от самого активного проекта, 0..1: длина полосы. */
  share: number
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

/** Записи лога за период по проектам, самые активные сверху; проекты без записей не показываются. */
export function activityByProject(projects: ProjectView[], r: Range): ProjectActivity[] {
  const rows = projects
    .map((p) => ({
      slug: p.data.slug,
      title: p.data.title,
      status: p.data.status,
      count: (p.data.log ?? []).filter((e) => isIn(dayOf(e.at), r)).length,
      share: 0,
    }))
    .filter((a) => a.count > 0)
    .sort((a, b) => b.count - a.count || collator.compare(a.title, b.title))
  const max = rows[0]?.count ?? 0
  for (const a of rows) a.share = max ? a.count / max : 0
  return rows
}

// ---------- Опубликовано ----------

export interface Published {
  slug: string
  title: string
  /** Местная дата перехода в «готово». */
  day: string
}

/** Проекты, ушедшие в «готово» за период (doneAt, ADR-009); свежие сверху. Без doneAt дату не выдумываем. */
export function published(projects: ProjectView[], r: Range): Published[] {
  const out: Published[] = []
  for (const p of projects) {
    if (p.data.status !== 'done') continue
    const day = dayOf(p.data.doneAt)
    if (day && inRange(day, r)) out.push({ slug: p.data.slug, title: p.data.title, day })
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || collator.compare(a.title, b.title))
}

export const shortDate = dm

// ---------- Пульс за период ----------

export interface StatsDay {
  date: string
  count: number
  level: number
  /** День вне периода: до его начала или ещё не наступил. */
  out: boolean
}

export interface StatsPulse {
  /** Недели с понедельника: от недели начала периода до текущей. */
  weeks: StatsDay[][]
  max: number
}

/** Тепловая карта записей лога по дням периода. Уровни — как на «Сегодня», коммиты добавятся с виджетами. */
export function statsPulse(projects: ProjectView[], r: Range): StatsPulse {
  const byDay = new Map<string, number>()
  for (const p of projects) {
    for (const e of p.data.log ?? []) {
      const key = dayOf(e.at)
      if (key && inRange(key, r)) byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }
  }
  const [sy, sm, sd] = r.start.split('-').map(Number) as [number, number, number]
  const start = new Date(sy, sm - 1, sd)
  // getDay(): 0 — воскресенье; через new Date(г, м, д + i), чтобы летнее время не сдвигало даты.
  const first = new Date(sy, sm - 1, sd - ((start.getDay() + 6) % 7))
  const weeks: StatsDay[][] = []
  for (let i = 0; ; i++) {
    const key = localKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
    if (i % 7 === 0) {
      if (key > r.end) break
      weeks.push([])
    }
    const out = !inRange(key, r)
    weeks[weeks.length - 1]!.push({ date: key, count: out ? 0 : (byDay.get(key) ?? 0), level: 0, out })
  }
  const max = Math.max(0, ...weeks.flat().map((d) => d.count))
  for (const w of weeks) for (const d of w) d.level = pulseLevel(d.count, max)
  return { weeks, max }
}
