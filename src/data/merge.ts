// Трёхстороннее слияние файлов данных (ADR-004, шаг 3): база / моё / удалённое.
// Чистые функции: без сети, IndexedDB и мутаций входа. Работают на уже разобранном JSON
// (битый JSON и версию формата проверяет parseFile в model.ts).
//
// Правила:
// - поле изменилось с одной стороны — берём изменение; с обеих одинаково — ок; по-разному — конфликт поля;
// - служебные метки времени (SERVICE_TIMES) на верхнем уровне и в элементах id-массивов при расхождении
//   берутся более поздние (только полный ISO-8601 с временем и смещением), в конфликт не попадают;
// - массивы объектов с уникальным строковым `id` сливаются поэлементно, поля элемента — по тем же правилам;
//   отсутствующий ключ против id-массива считается пустым массивом (applyEdit убирает пустые log/links);
//   удалено с одной стороны и не менялось с другой — удаляем; удалено и изменено — конфликт элемента,
//   в результате элемент остаётся (ADR: по умолчанию «оставить») на своей позиции из базы;
// - id-массив изменён только с одной стороны — берётся целиком, вместе с перестановкой;
//   с обеих — порядок удалённый, новые элементы с моей стороны в конец в моём порядке;
// - вложенность глубже MAX_DEPTH — отказ MergeRefused (рекурсия не должна падать с RangeError);
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

/** Предельная вложенность JSON (корень — уровень 1). В данных хаба её не больше 4. */
export const MAX_DEPTH = 64

/** Полный момент ISO-8601, как dateTime в схеме: дата, время и смещение обязательны. */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Слияние отказано — файл уходит во «Входящие конфликты» целиком: формат новее, чем понимает сборка
 * (ADR-003: такие файлы не перезаписываем), или вложенность глубже MAX_DEPTH.
 */
export class MergeRefused extends Error {
  /** Версия формата, если отказ из-за неё; иначе null. */
  readonly version: number | null
  constructor(message: string, version: number | null = null) {
    super(message)
    this.name = 'MergeRefused'
    this.version = version
  }
}

const tooDeep = () => new MergeRefused(`Слияние: вложенность данных глубже ${MAX_DEPTH} уровней.`)

/**
 * Слить мою версию файла с удалённой относительно базовой копии.
 * base === undefined — базы нет (файл создан с обеих сторон независимо): поле, которое есть только с одной
 * стороны, берётся; разные значения с двух сторон — конфликт (кроме служебных меток); элементы id-массивов
 * объединяются.
 */
export function merge(base: JsonObject | undefined, local: JsonObject, remote: JsonObject): MergeResult {
  for (const side of [base, local, remote]) {
    if (side === undefined) continue
    if (!isObject(side)) throw new TypeError('Слияние: файл данных должен быть JSON-объектом')
    const v = side.schemaVersion
    if (typeof v === 'number' && v > SCHEMA_VERSION) {
      throw new MergeRefused(`Файл в формате v${v}, эта версия хаба понимает только v${SCHEMA_VERSION}: слияние невозможно.`, v)
    }
    if (depthExceeds(side)) throw tooDeep()
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

// Вызывается только для полей верхнего уровня и полей элементов id-массивов (вложенные объекты — скаляры),
// поэтому SERVICE_TIMES действуют ровно там.
function mergeValue(key: string, base: Json | undefined, local: Json | undefined, remote: Json | undefined, path: MergePath, conflicts: MergeConflict[]): Json | undefined {
  if (idArrays(base, local, remote)) {
    // Отсутствующий ключ = пустой массив. Если после слияния пусто, а с одной из сторон ключа не было, — ключа нет.
    const absent = local === undefined || remote === undefined
    const v = mergeIdArray((base ?? []) as JsonObject[], (local ?? []) as JsonObject[], (remote ?? []) as JsonObject[], path, conflicts)
    return v.length === 0 && absent ? undefined : v
  }
  if (path.length === 1 && SET_FIELDS.has(key)) {
    // Отсутствующий ключ = пустой набор (как у id-массивов).
    const set = mergeStringSet(base, local, remote)
    if (set) return set.length === 0 && (local === undefined || remote === undefined) ? undefined : set
  }
  if (equal(local, remote)) return clone(local)
  if (equal(base, local)) return clone(remote)
  if (equal(base, remote)) return clone(local)
  if (SERVICE_TIMES.has(key)) {
    const later = laterTime(local, remote)
    if (later !== undefined) return later
  }
  conflicts.push({ kind: 'field', path, base: clone(base), local: clone(local), remote: clone(remote) })
  return clone(remote)
}

// ADR-008: теги — набор, а не значение. Добавленное с любой стороны сохраняется, удалённое с любой — удаляется;
// порядок — удалённый, мои новые в конце. Не массив строк (чужие данные) — обычное правило скаляра.
const SET_FIELDS = new Set(['tags'])

function mergeStringSet(base: Json | undefined, local: Json | undefined, remote: Json | undefined): string[] | undefined {
  const strings = (v: Json | undefined): string[] | undefined =>
    v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
  const b = strings(base)
  const l = strings(local)
  const r = strings(remote)
  if (!b || !l || !r) return undefined
  const inB = new Set(b)
  const inL = new Set(l)
  const inR = new Set(r)
  const out = r.filter((x) => !(inB.has(x) && !inL.has(x)))
  for (const x of l) if (!inR.has(x) && !inB.has(x)) out.push(x)
  return [...new Set(out)]
}

function mergeIdArray(base: JsonObject[], local: JsonObject[], remote: JsonObject[], path: MergePath, conflicts: MergeConflict[]): Json[] {
  // Изменение только с одной стороны (включая перестановку) берём целиком.
  if (equal(local, remote) || equal(base, remote)) return clone(local)
  if (equal(base, local)) return clone(remote)
  const baseById = byId(base)
  const localById = byId(local)
  const remoteById = byId(remote)
  const out: { id: string; v: Json }[] = []
  const take = (id: string): Json | undefined => {
    const b = baseById.get(id)
    const l = localById.get(id)
    const r = remoteById.get(id)
    const p = [...path, id]
    if (l && r) return mergeObject(b, l, r, p, conflicts)
    if (!b) return clone((l ?? r) as JsonObject)
    // Удалено с одной стороны (с обеих — сюда не попадаем: id нет ни в local, ни в remote).
    const kept = (l ?? r) as JsonObject
    if (equal(b, kept)) return undefined
    conflicts.push({ kind: 'element', path: p, deletedBy: l ? 'remote' : 'local', base: clone(b), local: clone(l), remote: clone(r) })
    return clone(kept)
  }
  // 1. Удалённый порядок.
  for (const e of remote) {
    const id = e.id as string
    const v = take(id)
    if (v !== undefined) out.push({ id, v })
  }
  // 2. Удалено на сервере, изменено у меня — на прежнее место: после ближайшего предшественника из базы, который остался.
  base.forEach((e, i) => {
    const id = e.id as string
    if (remoteById.has(id) || !localById.has(id)) return
    const v = take(id)
    if (v === undefined) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const prev = out.findIndex((x) => x.id === base[j]!.id)
      if (prev >= 0) {
        at = prev + 1
        break
      }
    }
    out.splice(at, 0, { id, v })
  })
  // 3. Новые у меня — в конец, в моём порядке.
  for (const e of local) {
    const id = e.id as string
    if (!remoteById.has(id) && !baseById.has(id)) out.push({ id, v: take(id) as Json })
  }
  return out.map((x) => x.v)
}

/**
 * Массив сливается по id, только если на всех сторонах, где ключ есть, это массив объектов с уникальным
 * строковым id. Отсутствие ключа с любой стороны — пустой массив.
 */
function idArrays(...sides: (Json | undefined)[]): boolean {
  const present = sides.filter((s) => s !== undefined)
  if (present.length === 0) return false
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
  if (!ISO_MOMENT.test(local) || !ISO_MOMENT.test(remote)) return undefined
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
export function equal(a: Json | undefined, b: Json | undefined, depth = 1): boolean {
  if (a === b) return true
  if (depth > MAX_DEPTH) throw tooDeep()
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i], depth + 1))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && equal(a[k], b[k], depth + 1))
  }
  return false
}

/** Глубже MAX_DEPTH? Обход без рекурсии, чтобы сама проверка не упала на злом файле. */
function depthExceeds(root: Json): boolean {
  const stack: [Json, number][] = [[root, 1]]
  while (stack.length) {
    const [v, d] = stack.pop()!
    if (typeof v !== 'object' || v === null) continue
    if (d > MAX_DEPTH) return true
    for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push([x, d + 1])
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
