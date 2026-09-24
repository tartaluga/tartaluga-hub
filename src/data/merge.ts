// Трёхстороннее слияние файлов данных (ADR-004, шаг 3): база / моё / удалённое.
// Чистые функции: без сети, IndexedDB и мутаций входа. Работают на уже разобранном JSON
// (битый JSON и версию формата проверяет parseFile в model.ts).
//
// Правила:
// - поле изменилось с одной стороны — берём изменение; с обеих одинаково — ок; по-разному — конфликт поля;
// - служебные метки времени (SERVICE_TIMES) при расхождении берутся более поздние, в конфликт не попадают;
// - массивы объектов с уникальным строковым `id` сливаются поэлементно, поля элемента — по тем же правилам;
//   удалено с одной стороны и не менялось с другой — удаляем; удалено и изменено — конфликт элемента,
//   в результате элемент остаётся (ADR: по умолчанию «оставить»);
// - порядок такого массива — удалённый, новые элементы с моей стороны в конец в моём порядке;
// - всё остальное (незнакомые поля, массивы без id, вложенные объекты) — как скаляры, сравнение по содержимому.
import { SCHEMA_VERSION } from './model'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** Путь до поля: имена полей, а для элементов массива с id — сам id. */
export type MergePath = string[]

export type MergeConflict =
  /** Поле поменяли с обеих сторон по-разному. undefined — поля нет (удалено). В merged лежит удалённое значение. */
  | { kind: 'field'; path: MergePath; base: Json | undefined; local: Json | undefined; remote: Json | undefined }
  /** Элемент удалён с одной стороны и изменён с другой. В merged элемент оставлен в изменённом виде. */
  | { kind: 'element'; path: MergePath; deletedBy: 'local' | 'remote'; base: Json; local: Json | undefined; remote: Json | undefined }

export interface MergeResult {
  merged: JsonObject
  conflicts: MergeConflict[]
}

/** Метки, которые при расхождении берутся по более позднему моменту (ADR-004: «updatedAt и подобные»). */
export const SERVICE_TIMES: ReadonlySet<string> = new Set(['updatedAt', 'doneAt'])

/** Слияние отказано: файл в формате новее, чем понимает сборка (ADR-003: такие файлы не перезаписываем). */
export class MergeRefused extends Error {
  readonly version: number
  constructor(version: number) {
    super(`Файл в формате v${version}, эта версия хаба понимает только v${SCHEMA_VERSION}: слияние невозможно.`)
    this.name = 'MergeRefused'
    this.version = version
  }
}

/**
 * Слить мою версию файла с удалённой относительно базовой копии.
 * base === undefined — базы нет (файл создан с обеих сторон независимо): любое расхождение — конфликт,
 * элементы массивов с id объединяются.
 */
export function merge(base: JsonObject | undefined, local: JsonObject, remote: JsonObject): MergeResult {
  for (const side of [base, local, remote]) {
    if (side === undefined) continue
    if (!isObject(side)) throw new TypeError('Слияние: файл данных должен быть JSON-объектом')
    const v = side.schemaVersion
    if (typeof v === 'number' && v > SCHEMA_VERSION) throw new MergeRefused(v)
  }
  const conflicts: MergeConflict[] = []
  const merged = mergeObject(base, local, remote, [], conflicts)
  return { merged, conflicts }
}

function mergeObject(base: JsonObject | undefined, local: JsonObject, remote: JsonObject, path: MergePath, conflicts: MergeConflict[]): JsonObject {
  const out: JsonObject = {}
  // Порядок ключей: удалённый, затем новые мои — чтобы дифф файла был минимальным.
  const keys = [...Object.keys(remote), ...Object.keys(local).filter((k) => !hasOwn(remote, k))]
  for (const k of keys) {
    const v = mergeValue(k, get(base, k), get(local, k), get(remote, k), [...path, k], conflicts)
    if (v !== undefined) put(out, k, v)
  }
  // Ключ, который удалили с одной стороны, не попал ни в remote, ни в local — и не должен: удаление принято.
  // Ключ, удалённый удалённо и изменённый у меня, уже в keys (он есть в local).
  return out
}

function mergeValue(key: string, base: Json | undefined, local: Json | undefined, remote: Json | undefined, path: MergePath, conflicts: MergeConflict[]): Json | undefined {
  if (equal(local, remote)) return clone(local)
  if (idArrays(base, local, remote)) return mergeIdArray(base as JsonObject[] | undefined, local as JsonObject[], remote as JsonObject[], path, conflicts)
  if (equal(base, local)) return clone(remote)
  if (equal(base, remote)) return clone(local)
  if (SERVICE_TIMES.has(key)) {
    const later = laterTime(local, remote)
    if (later !== undefined) return later
  }
  conflicts.push({ kind: 'field', path, base: clone(base), local: clone(local), remote: clone(remote) })
  return clone(remote)
}

function mergeIdArray(base: JsonObject[] | undefined, local: JsonObject[], remote: JsonObject[], path: MergePath, conflicts: MergeConflict[]): Json[] {
  const baseById = byId(base ?? [])
  const localById = byId(local)
  const remoteById = byId(remote)
  const out: Json[] = []
  const take = (id: string) => {
    const b = baseById.get(id)
    const l = localById.get(id)
    const r = remoteById.get(id)
    const p = [...path, id]
    if (l && r) {
      out.push(mergeObject(b, l, r, p, conflicts))
    } else if (b) {
      // Удалено с одной стороны (с обеих — сюда не попадаем: id нет ни в local, ни в remote).
      const kept = (l ?? r) as JsonObject
      if (equal(b, kept)) return
      conflicts.push({ kind: 'element', path: p, deletedBy: l ? 'remote' : 'local', base: clone(b), local: clone(l), remote: clone(r) })
      out.push(clone(kept))
    } else {
      out.push(clone((l ?? r) as JsonObject))
    }
  }
  for (const e of remote) take(e.id as string)
  for (const e of local) if (!remoteById.has(e.id as string)) take(e.id as string)
  return out
}

/** Массив сливается по id, только если на всех сторонах, где он есть, это массив объектов с уникальным строковым id. */
function idArrays(...sides: (Json | undefined)[]): boolean {
  const present = sides.filter((s) => s !== undefined)
  // База может отсутствовать; local и remote должны быть массивами.
  if (!Array.isArray(sides[1]) || !Array.isArray(sides[2])) return false
  return present.every((s) => {
    if (!Array.isArray(s)) return false
    const ids = new Set<string>()
    for (const e of s) {
      if (!isObject(e) || typeof e.id !== 'string' || ids.has(e.id)) return false
      ids.add(e.id)
    }
    return true
  })
}

function byId(arr: JsonObject[]): Map<string, JsonObject> {
  return new Map(arr.map((e) => [e.id as string, e]))
}

/** Более поздний момент из двух ISO-строк; undefined, если одна из сторон не момент (удалена или не разбирается). */
function laterTime(local: Json | undefined, remote: Json | undefined): string | undefined {
  if (typeof local !== 'string' || typeof remote !== 'string') return undefined
  const l = Date.parse(local)
  const r = Date.parse(remote)
  if (Number.isNaN(l) || Number.isNaN(r)) return undefined
  return l > r ? local : remote
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hasOwn(o: JsonObject, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

function get(o: JsonObject | undefined, k: string): Json | undefined {
  return o !== undefined && hasOwn(o, k) ? o[k] : undefined
}

/** Запись без сеттеров прототипа: ключ «__proto__» из JSON остаётся обычным полем. */
function put(o: JsonObject, k: string, v: Json): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

/** Равенство по содержимому; порядок ключей объекта не важен, порядок массива важен. */
export function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && equal(a[k], b[k]))
  }
  return false
}

function clone<T extends Json | undefined>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T
  if (isObject(v)) {
    const out: JsonObject = {}
    for (const k of Object.keys(v)) put(out, k, clone(v[k] as Json))
    return out as T
  }
  return v
}
