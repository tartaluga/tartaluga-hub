// Экран «Сегодня» (макет 1a): что горит, следующие шаги, заброшенные, пульс по логу.
// Чистые функции поверх buildLibrary: «сегодня» всегда приходит параметром, даты из файлов — местные.
import { plural } from '../lib/plural'
import { daysUntil, deadlineText, isHot, STATUSES, type ProjectView, type Status } from './projects'

// ---------- Горит ----------

export interface HotItem {
  kind: 'task' | 'milestone'
  /** id задачи или вехи — ключ строки. */
  id: string
  title: string
  due: string
  /** Дней до срока: 0 — сегодня, отрицательное — просрочено. */
  days: number
  slug: string
  project: string
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

/**
 * Открытые задачи и незакрытые вехи со сроком не дальше 3 дней, просроченные тоже.
 * Горят только проекты в работе (решение владельца): у идеи, паузы, готового и архива сроки на главном экране — шум.
 */
export function hotItems(projects: ProjectView[], today: Date): HotItem[] {
  const out: HotItem[] = []
  for (const p of projects) {
    const d = p.data
    if (d.status !== 'active') continue
    const tasks = d.tasks ?? []
    const push = (kind: HotItem['kind'], id: string, title: string, due: string) => {
      const days = daysUntil(due, today)
      if (isHot({ days })) out.push({ kind, id, title, due, days, slug: d.slug, project: d.title })
    }
    for (const t of tasks) if (!t.done && t.due) push('task', t.id, t.title, t.due)
    for (const m of d.milestones ?? []) {
      if (!m.due) continue
      const own = tasks.filter((t) => t.milestoneId === m.id)
      // Как в deadlineOf: веха, где все задачи сделаны, уже не грозит.
      if (own.length === 0 || own.some((t) => !t.done)) push('milestone', m.id, m.title, m.due)
    }
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || collator.compare(a.project, b.project) || collator.compare(a.title, b.title))
}

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

/** Подпись срока в строке «Горит»: «−2 дн · 21.09», «сегодня», «завтра», «26.09 · пт». */
export function hotWhen(item: { due: string; days: number }): string {
  const text = deadlineText(item)
  if (item.days < 2) return text
  const [y, m, d] = item.due.split('-').map(Number) as [number, number, number]
  return `${text} · ${WEEKDAY[new Date(y, m - 1, d).getDay()]}`
}

// ---------- Следующие шаги и заброшенные ----------

/** Проекты в работе с заданным шагом, свежие сверху. */
export function nextSteps(projects: ProjectView[]): ProjectView[] {
  return projects
    .filter((p) => p.data.status === 'active' && (p.data.nextStep ?? '').trim() !== '')
    .sort((a, b) => b.activityAt - a.activityAt || collator.compare(a.data.title, b.data.title))
}

/** Проекты в работе, где лог молчит дольше порога; по умолчанию самые тихие сверху, можно наоборот. */
export function abandoned(projects: ProjectView[], quietestFirst = true): (ProjectView & { silentDays: number })[] {
  const dir = quietestFirst ? 1 : -1
  return projects
    .filter((p): p is ProjectView & { silentDays: number } => p.data.status === 'active' && p.silentDays !== null)
    .sort((a, b) => dir * (b.silentDays - a.silentDays) || collator.compare(a.data.title, b.data.title))
}

// ---------- Пульс ----------

export interface PulseDay {
  /** YYYY-MM-DD, местная дата. */
  date: string
  count: number
  /** 0 — пусто, 1..4 — насыщенность относительно самого активного дня. */
  level: number
  /** День ещё не наступил (хвост текущей недели). */
  future: boolean
}

export interface Pulse {
  /** Недели слева направо, в каждой 7 дней с понедельника. Последняя — текущая. */
  weeks: PulseDay[][]
  max: number
  /** Записей лога в текущем календарном месяце. */
  monthCount: number
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Местная дата момента как YYYY-MM-DD. */
export function localKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Уровень клетки: доля от максимума, округлённая вверх до четвертей — любой ненулевой день виден. */
export function pulseLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.ceil((count / max) * 4))
}

/**
 * Тепловая карта записей лога по дням за последние weeks недель.
 * Недели с понедельника, как в русском календаре; архивные проекты тоже считаются — это история, а не список дел.
 * Коммиты добавятся на этапе 7 (ветка status), пока только лог.
 */
export function pulse(projects: ProjectView[], today: Date, weeks = 12): Pulse {
  const byDay = new Map<string, number>()
  let monthCount = 0
  for (const p of projects) {
    for (const e of p.data.log ?? []) {
      const t = Date.parse(e.at)
      if (Number.isNaN(t)) continue
      const d = new Date(t)
      const key = localKey(d)
      byDay.set(key, (byDay.get(key) ?? 0) + 1)
      if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) monthCount++
    }
  }
  // getDay(): 0 — воскресенье; сдвиг до понедельника текущей недели.
  const offset = (today.getDay() + 6) % 7
  const todayKey = localKey(today)
  // Дни строим через new Date(г, м, д + i): так переход на летнее время не сдвигает даты.
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset - (weeks - 1) * 7)
  const days: PulseDay[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const key = localKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
    const future = key > todayKey
    days.push({ date: key, count: future ? 0 : (byDay.get(key) ?? 0), level: 0, future })
  }
  const max = Math.max(0, ...days.map((d) => d.count))
  for (const d of days) d.level = pulseLevel(d.count, max)
  const out: PulseDay[][] = []
  for (let w = 0; w < weeks; w++) out.push(days.slice(w * 7, w * 7 + 7))
  return { weeks: out, max, monthCount }
}

const MONTH = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

/** Подпись под пульсом: «31 запись за сентябрь». */
export function pulseCaption(monthCount: number, today: Date): string {
  const month = MONTH[today.getMonth()]!
  if (monthCount === 0) return `За ${month} записей в логе нет`
  return `${monthCount} ${plural(monthCount, 'запись', 'записи', 'записей')} за ${month}`
}

// ---------- Статусы ----------

export interface StatusShare {
  status: Status
  count: number
  /** Доля от всех проектов, 0..1. */
  share: number
}

/** Все статусы в порядке легенды, архив тоже; у пустой библиотеки доли нулевые. */
export function statusShares(projects: ProjectView[]): StatusShare[] {
  const total = projects.length
  return STATUSES.map((status) => {
    const count = projects.filter((p) => p.data.status === status).length
    return { status, count, share: total ? count / total : 0 }
  })
}

// ---------- Шапка ----------

/** Надзаголовок: «ВТ · 23.09.2026 · 14:32» (капс делает CSS). */
export function eyebrowDate(now: Date): string {
  return `${WEEKDAY[now.getDay()]} · ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} · ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** Сводка под заголовком: «4 дедлайна, 1 просрочен · 2 проекта без активности». */
export function summary(hot: HotItem[], abandonedCount: number, projectCount: number): string {
  if (projectCount === 0) return 'Проектов пока нет'
  const overdue = hot.filter((h) => h.days < 0).length
  let head = hot.length
    ? `${hot.length} ${plural(hot.length, 'дедлайн', 'дедлайна', 'дедлайнов')}`
    : 'Горящих сроков нет'
  if (overdue) head += `, ${overdue} ${plural(overdue, 'просрочен', 'просрочено', 'просрочено')}`
  if (!abandonedCount) return head
  return `${head} · ${abandonedCount} ${plural(abandonedCount, 'проект', 'проекта', 'проектов')} без активности`
}
