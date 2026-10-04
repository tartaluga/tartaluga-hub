// Правки задачи с записью в лог (ADR-016 п. 3): смена статуса или срока — одной правкой с записью вида `task`.
// Чистые функции: сеть и очередь — в session.ts. Изменения мимо хаба (скилл, ручная правка) записей не создают.
import { ulid } from 'ulid'
import type { Comment, LogEntry, Task } from '../schema/types'
import { nowIso } from './model'
import { shortDate, type ProjectPatch, type TaskChange } from './editProject'

/** Четыре состояния задачи: done + inProgress + cancelled (ADR-016). */
export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled'

export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled']

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'К выполнению',
  doing: 'В работе',
  done: 'Готово',
  cancelled: 'Отменена',
}

/** Что написать в логе: «Название»: <фраза>. */
const LOG_PHRASE: Record<TaskStatus, string> = {
  todo: 'снова к выполнению',
  doing: 'в работе',
  done: 'готово',
  cancelled: 'отменена',
}

/** `done` главный: метка «в работе» при done = true не показывается, «отменена» при done = false — тоже. */
export function taskStatus(t: Pick<Task, 'done' | 'inProgress' | 'cancelled'>): TaskStatus {
  if (t.done) return t.cancelled ? 'cancelled' : 'done'
  return t.inProgress ? 'doing' : 'todo'
}

const TITLE_IN_LOG = 80

function logTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ') || 'Без названия'
  return t.length > TITLE_IN_LOG ? `${t.slice(0, TITLE_IN_LOG)}…` : t
}

function taskLog(task: Pick<Task, 'id' | 'title'>, phrase: string, now: Date): LogEntry {
  return { id: ulid(), at: nowIso(now), kind: 'task', text: `«${logTitle(task.title)}»: ${phrase}`, taskId: task.id }
}

/** Новый статус: поля задачи и запись лога. null — статус уже такой, писать нечего. */
export function setTaskStatus(task: Pick<Task, 'id' | 'title' | 'done' | 'inProgress' | 'cancelled' | 'doneAt'>, to: TaskStatus, now = new Date()): ProjectPatch | null {
  if (taskStatus(task) === to) return null
  const done = to === 'done' || to === 'cancelled'
  const change: TaskChange = {
    id: task.id,
    done,
    inProgress: to === 'doing' ? true : null,
    cancelled: to === 'cancelled' ? true : null,
  }
  // doneAt — момент закрытия: ставится при переходе в закрытое, при возврате убирается; «готово» ↔ «отменена» его не трогает.
  if (done && !task.done) change.doneAt = nowIso(now)
  if (!done) change.doneAt = null
  return { taskSet: [change], logAdd: [taskLog(task, LOG_PHRASE[to], now)] }
}

/** Галочка «готово» в списке: сделана ↔ снова к выполнению (у отменённой снимает «отмену»). */
export function toggleTaskDone(task: Pick<Task, 'id' | 'title' | 'done' | 'inProgress' | 'cancelled' | 'doneAt'>, now = new Date()): ProjectPatch {
  return setTaskStatus(task, task.done ? 'todo' : 'done', now) as ProjectPatch
}

/** Новый срок (null — без срока) и запись лога: «срок 05.10 → 12.10». null — срок не изменился. */
export function setTaskDue(task: Pick<Task, 'id' | 'title' | 'due'>, due: string | null, now = new Date()): ProjectPatch | null {
  if ((due ?? undefined) === task.due) return null
  const show = (d: string) => shortDate(d, now)
  const phrase = due === null ? `срок снят (было ${show(task.due ?? '')})` : task.due === undefined ? `срок ${show(due)}` : `срок ${show(task.due)} → ${show(due)}`
  return { taskSet: [{ id: task.id, due }], logAdd: [taskLog(task, phrase, now)] }
}

/** Новый комментарий; author — только у записанных скиллом Claude, хаб пишет без него (владелец). */
export function newComment(text: string, now = new Date()): Comment {
  return { id: ulid(), at: nowIso(now), text: text.replace(/\r\n?/g, '\n').trim() }
}

/** Подпись автора комментария: нет поля — владелец (без метки), claude — «Claude», прочее — «другой». */
export function commentAuthor(c: Pick<Comment, 'author'>): string | null {
  if (c.author === undefined) return null
  return c.author === 'claude' ? 'Claude' : 'другой'
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Задача из записи лога: ссылка есть, только если taskId — ULID и такая задача есть в проекте. */
export function logTaskId(entry: Pick<LogEntry, 'kind' | 'taskId'>, tasks: Pick<Task, 'id'>[]): string | null {
  const id = entry.taskId
  if (typeof id !== 'string' || !ULID_RE.test(id)) return null
  return tasks.some((t) => t.id === id) ? id : null
}

export const isTaskId = (s: string) => ULID_RE.test(s)
