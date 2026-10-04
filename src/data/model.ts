// Разбор и сериализация файлов данных по контракту ADR-003:
// - каждый файл проверяется отдельно, битый файл не валит остальные;
// - незнакомые поля проходят насквозь (работаем с исходным объектом, а не с урезанной копией);
// - файлы с версией формата выше нашей — только для чтения.
import { ulid } from 'ulid'
import type { Idea, Project, Settings, Task } from '../schema/types'
import { validateIdea, validateProject, validateSettings, type ValidateFn, type ValidationError } from '../schema/validators.js'

export type FileKind = 'project' | 'idea' | 'settings'

/** Максимальная версия формата каждого вида файлов, которую понимает эта сборка (ADR-009, п. 4). */
export const SCHEMA_VERSIONS: Readonly<Record<FileKind, number>> = Object.freeze({ project: 2, idea: 1, settings: 1 })

const KIND_LABEL: Record<FileKind, string> = { project: 'проектов', idea: 'идей', settings: 'настроек' }

/** Первый срок задачи для экранов и статистики: originalDue, а в файлах v1 и правках мимо хаба — due (ADR-009, п. 5). */
export function firstDue(task: Pick<Task, 'due' | 'originalDue'>): string | undefined {
  return task.originalDue ?? task.due
}

/** Тип данных плюс незнакомые поля, которые надо сохранить. */
export type WithUnknown<T> = T & Record<string, unknown>

type DataOf<K extends FileKind> = K extends 'project' ? Project : K extends 'idea' ? Idea : Settings

export type Parsed<K extends FileKind = FileKind> =
  | { ok: true; kind: K; path: string; sha: string; data: WithUnknown<DataOf<K>>; readOnly: false; idsAssigned: boolean }
  | { ok: true; kind: K; path: string; sha: string; data: WithUnknown<DataOf<K>>; readOnly: true; reason: string; idsAssigned: boolean }
  | { ok: false; kind: K | null; path: string; sha: string; error: string }

const VALIDATORS: Record<FileKind, ValidateFn> = {
  project: validateProject,
  idea: validateIdea,
  settings: validateSettings,
}

export function kindOfPath(path: string): FileKind | null {
  if (/^projects\/[^/]+\.json$/.test(path)) return 'project'
  if (/^ideas\/[^/]+\.json$/.test(path)) return 'idea'
  if (path === 'settings.json') return 'settings'
  return null
}

export function parseFile(path: string, sha: string, text: string): Parsed {
  const kind = kindOfPath(path)
  if (!kind) return { ok: false, kind: null, path, sha, error: 'Неизвестный файл' }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, kind, path, sha, error: `Файл не читается как JSON: ${(e as Error).message}` }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, kind, path, sha, error: 'В файле не объект JSON' }
  }

  const obj = json as Record<string, unknown>
  const idsAssigned = kind === 'project' ? assignMissingIds(obj) : false

  const validate = VALIDATORS[kind]
  if (!validate(obj)) return { ok: false, kind, path, sha, error: describeErrors(validate.errors) }

  const dupError = checkUniqueIds(kind, obj)
  if (dupError) return { ok: false, kind, path, sha, error: dupError }

  const nameError = checkFileName(kind, path, obj)
  if (nameError) return { ok: false, kind, path, sha, error: nameError }

  const version = obj.schemaVersion as number
  const known = SCHEMA_VERSIONS[kind]
  if (version > known) {
    return {
      ok: true,
      kind,
      path,
      sha,
      data: obj as never,
      readOnly: true,
      reason: `Файл записан в формате v${version}, а эта версия хаба понимает файлы ${KIND_LABEL[kind]} только до v${known}. Обнови хаб, чтобы править его.`,
      idsAssigned,
    }
  }
  return { ok: true, kind, path, sha, data: obj as never, readOnly: false, idsAssigned }
}

/** Предел файла данных в байтах UTF-8: столько принимает сервер (ADR-016), клиент не ставит в очередь больше. */
export const FILE_BYTES_LIMIT = 5 * 1024 * 1024

export const FILE_TOO_BIG: Record<'project' | 'idea', string> = {
  project: 'Проект слишком большой: сократите описания',
  idea: 'Идея слишком большая: сократите текст',
}

/** Файл не больше предела (размер в байтах UTF-8, не в символах). */
export const fitsFileLimit = (text: string): boolean => new TextEncoder().encode(text).byteLength <= FILE_BYTES_LIMIT

/**
 * Массивы объектов с id в проекте (ADR-003, правило 4; ADR-016): верхний уровень и вложенные в каждую задачу.
 * Единственное место списка: новый вложенный массив добавляется сюда, и присвоение id с проверкой повторов
 * подхватывают его сами.
 */
export const PROJECT_ID_ARRAYS: readonly string[] = ['links', 'milestones', 'tasks', 'log']
export const TASK_ID_ARRAYS: readonly string[] = ['links', 'comments']

interface IdArray {
  /** Как назвать массив в ошибке: links или tasks[<id задачи>].links. */
  label: string
  items: unknown[]
}

/** Верхние массивы по порядку списка, потом вложенные в задачи (задачи к этому времени уже с id). */
function idArrays(obj: Record<string, unknown>): IdArray[] {
  const out: IdArray[] = []
  for (const key of PROJECT_ID_ARRAYS) {
    const arr = obj[key]
    if (Array.isArray(arr)) out.push({ label: key, items: arr })
  }
  const tasks = obj.tasks
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) continue
      const t = task as Record<string, unknown>
      for (const key of TASK_ID_ARRAYS) {
        const arr = t[key]
        if (Array.isArray(arr)) out.push({ label: `tasks[${String(t.id)}].${key}`, items: arr })
      }
    }
  }
  return out
}

/** Задачи, вехи, ссылки, записи лога, а также ссылки и комментарии задач, добавленные руками без id, получают id. */
function assignMissingIds(obj: Record<string, unknown>): boolean {
  let changed = false
  const fill = (items: unknown[]) => {
    for (const item of items) {
      if (item && typeof item === 'object' && !Array.isArray(item) && !('id' in item)) {
        ;(item as Record<string, unknown>).id = ulid()
        changed = true
      }
    }
  }
  // Сначала верхний уровень (у задач появятся id), потом вложенные массивы.
  for (const key of PROJECT_ID_ARRAYS) {
    const arr = obj[key]
    if (Array.isArray(arr)) fill(arr)
  }
  for (const { label, items } of idArrays(obj)) if (label.startsWith('tasks[')) fill(items)
  return changed
}

/** Схема не ловит повторы id в массивах, а правки и слияние адресуют элементы по id — повтор делает файл неоднозначным. */
function checkUniqueIds(kind: FileKind, obj: Record<string, unknown>): string | null {
  const arrays: IdArray[] = kind === 'project' ? idArrays(obj) : kind === 'settings' && Array.isArray(obj.tags) ? [{ label: 'tags', items: obj.tags }] : []
  // Уникальность — в пределах одного массива: одинаковый id у ссылок разных задач не ошибка.
  for (const { label, items } of arrays) {
    const seen = new Set<unknown>()
    for (const item of items) {
      if (!item || typeof item !== 'object' || !('id' in item)) continue
      const id = (item as Record<string, unknown>).id
      if (seen.has(id)) return `два элемента ${label} с id «${String(id)}»`
      seen.add(id)
    }
  }
  return null
}

function checkFileName(kind: FileKind, path: string, obj: Record<string, unknown>): string | null {
  const name = path.split('/').pop()!.replace(/\.json$/, '')
  if (kind === 'project' && obj.slug !== name) return `slug «${String(obj.slug)}» не совпадает с именем файла «${name}»`
  if (kind === 'idea' && obj.id !== name) return `id «${String(obj.id)}» не совпадает с именем файла «${name}»`
  return null
}

export function describeErrors(errors: ValidationError[] | null | undefined): string {
  if (!errors?.length) return 'Файл не соответствует схеме'
  // Ошибки веток if/then дублируют конкретную причину — показываем только конкретные.
  const useful = errors.filter((e) => e.keyword !== 'if')
  return useful
    .slice(0, 3)
    .map((e) => `${e.instancePath || '(корень)'}: ${e.message ?? e.keyword}`)
    .join('; ')
}

/** Одинаковое форматирование для всех, кто пишет файлы: 2 пробела, перевод строки в конце. */
export function serialize(data: object): string {
  return JSON.stringify(data, null, 2) + '\n'
}

/** Текущий момент в ISO 8601 с локальным смещением: 2026-09-23T03:40:00+03:00. */
export function nowIso(date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  )
}

/** 'YYYY-MM-DD' как местная дата (а не UTC, как делает new Date(str)). */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

/** Slug из названия: транслит кириллицы, латиница, цифры и дефисы. */
export function slugify(title: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  }
  const s = title
    .toLowerCase()
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return s || 'project'
}

/** Свободный slug: если занят, добавляем -2, -3… */
export function uniqueSlug(title: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugify(title)
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`
}
