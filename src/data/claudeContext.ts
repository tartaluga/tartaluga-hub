// «Скопировать контекст для Claude» (D5): Markdown-сводка проекта для старта новой сессии Claude.
// Чистая функция. Данные из репо — недоверенный ввод: здесь они только склеиваются в текст, ничего не
// исполняется и не превращается в разметку интерфейса. Однострочные поля сжимаются в одну строку и
// обрезаются, чтобы чужой перевод строки не притворялся заголовком раздела; описание идёт целиком.
import type { Link, LogEntry, Milestone, Project, Task } from '../schema/types'
import { LINK_KIND_LABEL, linkHref, logKindLabel, sortedLog, type LinkKind } from './editProject'
import { STATUS_LABEL, type Status } from './projects'

export interface ClaudeContextOptions {
  /** Сколько последних записей лога взять. По умолчанию 5. */
  logLimit?: number
  /** Сколько открытых задач перечислить, остальные — строкой «…и ещё N». По умолчанию 30. */
  taskLimit?: number
}

/** Предел длины однострочного поля (название, шаг, задача, ссылка). */
export const LINE_MAX = 300
/** Предел длины текста записи лога. */
export const LOG_TEXT_LIMIT = 600

/** Одна строка: переводы строк и повторные пробелы — в один пробел, длиннее max — обрезать с «…». */
export function oneLineCut(raw: unknown, max = LINE_MAX): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

function statusText(status: unknown): string {
  return STATUS_LABEL[status as Status] ?? oneLineCut(status, 40)
}

function linkLine(l: Link): string | null {
  const value = oneLineCut(l.kind === 'repo' ? (linkHref(l) ?? l.value) : l.value)
  if (!value) return null
  const kind = LINK_KIND_LABEL[l.kind as LinkKind] ?? 'Ссылка'
  const label = oneLineCut(l.label, 80)
  return `- ${kind}${label ? ` «${label}»` : ''}: ${value}`
}

function taskLine(t: Task, milestones: Map<string, Milestone>): string | null {
  const title = oneLineCut(t.title)
  if (!title) return null
  const extra: string[] = []
  if (t.due) extra.push(`срок ${oneLineCut(t.due, 20)}`)
  const m = t.milestoneId ? milestones.get(t.milestoneId) : undefined
  const mTitle = m && oneLineCut(m.title, 120)
  if (mTitle) extra.push(`веха «${mTitle}»`)
  return `- [ ] ${title}${extra.length ? ` — ${extra.join(', ')}` : ''}`
}

/** Дата записи так, как её записал автор (часть YYYY-MM-DD из ISO), без пересчёта в часовой пояс читателя. */
function logDate(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(at)
  return m?.[1] ?? oneLineCut(at, 40)
}

function logLine(e: LogEntry): string | null {
  const text = oneLineCut(e.text, LOG_TEXT_LIMIT)
  if (!text) return null
  return `- ${logDate(e.at)} · ${logKindLabel(e.kind)}: ${text}`
}

function section(title: string, body: string[]): string[] {
  return body.length ? [`## ${title}`, '', ...body, ''] : []
}

/** Markdown-текст контекста проекта. Пустые разделы и строки пропускаются. */
export function buildClaudeContext(project: Project, opts: ClaudeContextOptions = {}): string {
  const logLimit = Math.max(0, opts.logLimit ?? 5)
  const taskLimit = Math.max(0, opts.taskLimit ?? 30)
  const links = project.links ?? []

  const head: string[] = [`# Проект: ${oneLineCut(project.title) || oneLineCut(project.slug)}`, '']
  const folder = links.find((l) => l.kind === 'folder' && oneLineCut(l.value))
  if (folder) head.push(`- Папка на ПК: ${oneLineCut(folder.value)}`)
  head.push(`- Статус: ${statusText(project.status)}`)
  const next = oneLineCut(project.nextStep)
  if (next) head.push(`- Следующий шаг: ${next}`)
  head.push('')

  const description = typeof project.description === 'string' ? project.description.trim() : ''

  const stack = (project.stack ?? []).map((s) => oneLineCut(s, 80)).filter(Boolean)

  const otherLinks = links.filter((l) => l !== folder).map(linkLine).filter((x): x is string => x !== null)

  const milestones = new Map((project.milestones ?? []).map((m) => [m.id, m]))
  const open = (project.tasks ?? []).filter((t) => !t.done).map((t) => taskLine(t, milestones)).filter((x): x is string => x !== null)
  const tasks = open.slice(0, taskLimit)
  if (open.length > tasks.length) tasks.push(`- …и ещё ${open.length - tasks.length}`)

  const log = sortedLog(project.log).map(logLine).filter((x): x is string => x !== null).slice(0, logLimit)

  const out = [
    ...head,
    ...section('Описание', description ? [description] : []),
    ...section('Стек', stack.map((s) => `- ${s}`)),
    ...section('Ссылки', otherLinks),
    ...section('Открытые задачи', tasks),
    ...section('Последние записи лога (новые сверху)', log),
  ]
  return `${out.join('\n').trimEnd()}\n`
}
