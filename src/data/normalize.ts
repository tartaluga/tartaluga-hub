// Инварианты формата v2 перед записью проекта (ADR-009, п. 6). Единственное место, где они держатся:
// чтение файлов не переписывает, слияние работает с сырыми файлами.
//
// Вызывать перед каждой записью проекта хабом: после правки, после слияния по ADR-004 и после выбора
// во «Входящих конфликтах». prev — моя версия файла до правки или слияния (для нового проекта — undefined).
import type { Project } from '../schema/types'
import { nowIso, SCHEMA_VERSIONS, type WithUnknown } from './model'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * Возвращает новый объект; аргументы не меняет. Незнакомые поля и порядок ключей сохраняются.
 * - doneAt: удаляется при status ≠ done; ставится = now, только если в prev статус был не done (или prev нет),
 *   в next стал done и даты нет. Проекты, закрытые до v2, при правке даты не получают;
 * - tasks[].originalDue: удаляется у задач без due; задаче с due без originalDue ставится первое найденное:
 *   originalDue этой задачи (по id) в prev, её due в prev, текущий due;
 * - schemaVersion: 2.
 */
export function normalizeProject<T extends WithUnknown<Project>>(prev: WithUnknown<Project> | undefined, next: T, now: string = nowIso()): T {
  const out: Obj = { ...next, schemaVersion: SCHEMA_VERSIONS.project }

  if (out.status !== 'done') delete out.doneAt
  else if (out.doneAt === undefined && (prev === undefined || prev.status !== 'done')) out.doneAt = now

  if (Array.isArray(next.tasks)) {
    const prevTasks = new Map<string, Obj>()
    for (const t of Array.isArray(prev?.tasks) ? prev.tasks : []) if (isObj(t) && typeof t.id === 'string') prevTasks.set(t.id, t)
    out.tasks = next.tasks.map((t: unknown) => (isObj(t) ? normalizeTask(t, prevTasks) : t))
  }

  return out as T
}

function normalizeTask(task: Obj, prevTasks: Map<string, Obj>): Obj {
  const due = str(task.due)
  if (due === undefined) {
    if (!('originalDue' in task)) return task
    const rest = { ...task }
    delete rest.originalDue
    return rest
  }
  if (str(task.originalDue) !== undefined) return task
  const before = typeof task.id === 'string' ? prevTasks.get(task.id) : undefined
  return { ...task, originalDue: str(before?.originalDue) ?? str(before?.due) ?? due }
}
