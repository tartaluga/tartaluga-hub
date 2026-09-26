// Входящие конфликты (ADR-004 шаг 5, ADR-010 §2): подписи спорных мест, показ значений и применение выбора.
// Чистые функции без сети. Данные из репо — недоверенный ввод: ключи пишутся без сеттеров прототипа,
// значения показываются только как текст.
import { FIELD_LABEL } from './editProject'
import { SERVICE_TIMES, type Json, type JsonObject, type MergeConflict, type MergePath } from './merge'
import { STATUS_LABEL, type Status } from './projects'

/** Что выбрали для спорного места: моя версия, версия из репо или текст, собранный по кускам. */
export type ConflictPick = 'mine' | 'repo' | { text: string }

/** Изменение файла при разрешении: поставить значение по пути (undefined — убрать поле или элемент). */
export interface ConflictOp {
  path: MergePath
  value: Json | undefined
}

const ARRAY_LABEL: Record<string, string> = { tasks: 'задача', log: 'запись лога', links: 'ссылка', milestones: 'веха' }
const ELEMENT_FIELD_LABEL: Record<string, string> = {
  title: 'название',
  done: 'отметка',
  due: 'срок',
  originalDue: 'исходный срок',
  text: 'текст',
  kind: 'вид',
  at: 'время',
  value: 'адрес',
  label: 'подпись',
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Короткое имя элемента массива: название задачи, начало записи лога, подпись ссылки. */
function elementName(e: Json | undefined): string | null {
  if (!isObject(e)) return null
  for (const k of ['title', 'label', 'text', 'value']) {
    const v = e[k]
    if (typeof v === 'string' && v.trim()) {
      const one = v.trim().replace(/\s+/g, ' ')
      return one.length > 40 ? `${one.slice(0, 39)}…` : one
    }
  }
  return null
}

/** Элемент id-массива по id в одной из версий файла. */
function findElement(doc: JsonObject | undefined, arrayKey: string, id: string): Json | undefined {
  const arr = doc && hasOwn(doc, arrayKey) ? doc[arrayKey] : undefined
  return Array.isArray(arr) ? arr.find((e) => isObject(e) && e.id === id) : undefined
}

/**
 * Подпись спорного места: «следующий шаг», «задача «Сдать главу» · срок», «задача «Макет» · удалена в репо».
 * local и remote — мои и удалённые данные файла, из них берутся имена элементов.
 */
export function conflictLabel(item: MergeConflict, local: JsonObject | undefined, remote: JsonObject | undefined): string {
  const [top = '', id, ...rest] = item.path
  if (id === undefined) return (FIELD_LABEL as Record<string, string>)[top] ?? top
  const name =
    elementName(item.kind === 'element' ? (item.local ?? item.remote ?? item.base) : undefined) ??
    elementName(findElement(remote, top, id)) ??
    elementName(findElement(local, top, id))
  const what = `${ARRAY_LABEL[top] ?? top}${name ? ` «${name}»` : ''}`
  if (item.kind === 'element') return `${what} · ${item.deletedBy === 'local' ? 'удалена у тебя' : 'удалена в репо'}`
  const field = rest[rest.length - 1] ?? ''
  return `${what} · ${ELEMENT_FIELD_LABEL[field] ?? field}`
}

/** Значение для показа (только текст). undefined — поля нет. */
export function formatValue(value: Json | undefined, key = ''): string {
  if (value === undefined || value === null || value === '') return '— пусто'
  if (typeof value === 'boolean') return key === 'done' ? (value ? 'выполнена' : 'не выполнена') : value ? 'да' : 'нет'
  if (typeof value === 'string') return key === 'status' ? (STATUS_LABEL[value as Status] ?? value) : value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return value.length ? value.join(', ') : '— пусто'
    const names = value.map((v) => elementName(v)).filter((n): n is string => n !== null)
    return names.length === value.length ? names.join(', ') : JSON.stringify(value)
  }
  return elementName(value) ?? JSON.stringify(value)
}

/** Что показать в карточке «моя» / «из репо»: у элемента, который удалили, — «удалена». */
export function sideText(item: MergeConflict, side: 'local' | 'remote'): string {
  const key = item.path[item.path.length - 1] ?? ''
  if (item.kind === 'element') return item[side] === undefined ? 'удалена' : formatValue(item[side], key)
  return formatValue(item[side], key)
}

/**
 * Длинный текст (ADR-010 §2): описание проекта, текст записи лога, текст идеи — и в нём несколько строк.
 * Для него выбор по кускам; однострочный текст — две кнопки, как у остальных полей.
 */
export function isLongText(item: MergeConflict): boolean {
  if (item.kind !== 'field') return false
  const p = item.path
  const listed = (p.length === 1 && (p[0] === 'description' || p[0] === 'text')) || (p.length === 3 && p[0] === 'log' && p[2] === 'text')
  if (!listed) return false
  const sides = [item.base, item.local, item.remote]
  return sides.every((v) => v === undefined || typeof v === 'string') && sides.some((v) => typeof v === 'string' && v.includes('\n'))
}

/**
 * Изменения файла по выбору. В файле в репо на спорном месте уже версия из репо (ADR-004: слившееся записано),
 * поэтому «из репо» ничего не меняет, а «моя» ставит моё значение.
 * Элемент, удалённый с одной стороны и изменённый с другой, в файле оставлен: выбор удаления его убирает.
 */
export function opsFor(item: MergeConflict, pick: ConflictPick): ConflictOp[] {
  if (typeof pick === 'object') return item.kind === 'field' ? [{ path: item.path, value: pick.text }] : []
  if (item.kind === 'field') return pick === 'mine' ? [{ path: item.path, value: item.local }] : []
  const deleteWins = (pick === 'mine') === (item.deletedBy === 'local')
  return deleteWins ? [{ path: item.path, value: undefined }] : []
}

/** Значение по пути (как у applyOps): имена полей, в массиве с id — id элемента. undefined — такого места нет. */
export function valueAt(doc: JsonObject, path: MergePath): Json | undefined {
  let cur: Json | undefined = doc
  for (const seg of path) {
    if (Array.isArray(cur)) cur = cur.find((e) => isObject(e) && e.id === seg)
    else if (isObject(cur)) cur = hasOwn(cur, seg) ? cur[seg] : undefined
    else return undefined
    if (cur === undefined) return undefined
  }
  return cur
}

/**
 * Что лежит на спорном месте в файле в репо после слияния (ADR-004: слившееся записано): у поля — версия из репо,
 * у элемента, удалённого с одной стороны, — изменённый элемент с другой.
 */
export function heldValue(item: MergeConflict): Json | undefined {
  if (item.kind === 'field') return item.remote
  return item.deletedBy === 'remote' ? item.local : item.remote
}

/** То же ли значение на спорном месте: без служебных меток времени (их проставляет нормализация). */
export function sameValue(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const wrap = (v: Json): JsonObject => (isObject(v) ? v : { v })
  return sameContent(wrap(a), wrap(b))
}

/** Поставить значение по пути: имена полей, в массиве с id — id элемента. Возвращает новый объект. */
export function applyOps(doc: JsonObject, ops: readonly ConflictOp[]): JsonObject {
  const out = structuredClone(doc)
  for (const op of ops) setAt(out, op.path, op.value)
  // Пустой массив после удаления элемента — ключа нет, как после правки в карточке (applyEdit).
  for (const op of ops) {
    const top = op.path[0]
    if (top !== undefined && op.path.length === 2 && hasOwn(out, top) && Array.isArray(out[top]) && (out[top] as Json[]).length === 0) delete out[top]
  }
  return out
}

function setAt(root: JsonObject, path: MergePath, value: Json | undefined): void {
  let cur: Json = root
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!
    const last = i === path.length - 1
    if (Array.isArray(cur)) {
      const idx: number = cur.findIndex((e) => isObject(e) && e.id === seg)
      if (last) {
        if (value === undefined) {
          if (idx >= 0) cur.splice(idx, 1)
        } else if (idx >= 0) cur[idx] = structuredClone(value)
        else cur.push(structuredClone(value))
        return
      }
      if (idx < 0) return // элемента уже нет — править нечего
      cur = cur[idx]!
    } else if (isObject(cur)) {
      if (last) {
        if (value === undefined) delete cur[seg]
        else Object.defineProperty(cur, seg, { value: structuredClone(value), enumerable: true, writable: true, configurable: true })
        return
      }
      const next: Json | undefined = hasOwn(cur, seg) ? cur[seg] : undefined
      if (next === undefined || next === null || typeof next !== 'object') return
      cur = next
    } else return
  }
}

/**
 * Совпадают ли версии без служебных меток времени (updatedAt, doneAt) — на верхнем уровне и в элементах
 * массивов. Так видно, что писать нечего: правка уже в репо, отличается только время.
 */
export function sameContent(a: JsonObject, b: JsonObject): boolean {
  return JSON.stringify(canonical(strip(a))) === JSON.stringify(canonical(strip(b)))
}

function strip(doc: JsonObject): JsonObject {
  const plain = (o: JsonObject) => Object.fromEntries(Object.entries(o).filter(([k]) => !SERVICE_TIMES.has(k)))
  return Object.fromEntries(
    Object.entries(plain(doc)).map(([k, v]) => [k, Array.isArray(v) ? v.map((e) => (isObject(e) ? plain(e) : e)) : v]),
  ) as JsonObject
}

/** Ключи объектов по порядку: сравнение не зависит от порядка полей. */
function canonical(v: Json): Json {
  if (Array.isArray(v)) return v.map(canonical)
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k]!)]))
  return v
}
