// Правка проекта на месте: нормализация полей, применение к файлу и слияние по полям при конфликте версий.
// Чистые функции — сеть и очередь записей в session.ts. Незнакомые поля файла проходят насквозь (ADR-003).
import { ulid } from 'ulid'
import type { Link, Project } from '../schema/types'
import { nowIso } from './model'
import { NEXT_STEP_MAX, TITLE_MAX } from './newProject'

/** Поля, которые правятся в карточке. null — убрать поле из файла. */
export interface ProjectPatch {
  title?: string
  description?: string | null
  stack?: string[] | null
  tags?: string[] | null
  status?: Project['status']
  nextStep?: string | null
  links?: Link[] | null
}

export const DESCRIPTION_MAX = 20_000
export const STACK_ITEM_MAX = 40
export const LINK_LABEL_MAX = 80

const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ')

/** Приводит правку к виду, в котором она пишется в файл: пробелы, пустое → null, повторы в списках убраны. */
export function normalizePatch(patch: ProjectPatch): ProjectPatch {
  const out: ProjectPatch = {}
  if (patch.title !== undefined) out.title = oneLine(patch.title)
  if (patch.status !== undefined) out.status = patch.status
  if (patch.nextStep !== undefined) out.nextStep = patch.nextStep === null ? null : oneLine(patch.nextStep) || null
  if (patch.description !== undefined) {
    // Переводы строк в описании значимы (Markdown), убираем только пустоту по краям и \r.
    const d = patch.description?.replace(/\r\n?/g, '\n').trim()
    out.description = d || null
  }
  if (patch.stack !== undefined) {
    const items = [...new Set((patch.stack ?? []).map(oneLine).filter(Boolean))]
    out.stack = items.length ? items : null
  }
  if (patch.tags !== undefined) {
    const items = [...new Set(patch.tags ?? [])]
    out.tags = items.length ? items : null
  }
  if (patch.links !== undefined) out.links = patch.links?.length ? patch.links : null
  return out
}

/** Ошибка, понятная человеку, или null. Схему файла проверит parseFile перед записью и сервер ещё раз. */
export function patchError(patch: ProjectPatch): string | null {
  if (patch.title !== undefined) {
    if (!patch.title) return 'Нужно название'
    if (patch.title.length > TITLE_MAX) return `Название длиннее ${TITLE_MAX} символов`
  }
  if (patch.nextStep && patch.nextStep.length > NEXT_STEP_MAX) return `Следующий шаг длиннее ${NEXT_STEP_MAX} символов`
  if (patch.description && patch.description.length > DESCRIPTION_MAX) return `Описание длиннее ${DESCRIPTION_MAX} символов`
  if (patch.stack?.some((s) => s.length > STACK_ITEM_MAX)) return `Пункт стека длиннее ${STACK_ITEM_MAX} символов`
  return null
}

/**
 * Новая версия файла: поля правки поверх исходного объекта, updatedAt — сейчас.
 * Порядок ключей сохраняется, незнакомые поля не трогаются, новые поля встают перед createdAt.
 */
export function applyEdit<T extends Record<string, unknown>>(data: T, patch: ProjectPatch, now = new Date()): T {
  const set = new Map(Object.entries(patch).filter(([, v]) => v !== undefined))
  const out: Record<string, unknown> = {}
  const put = (k: string, v: unknown) => {
    if (v !== null) out[k] = v
  }
  for (const [k, v] of Object.entries(data)) {
    if (k === 'createdAt') for (const [nk, nv] of set) if (!(nk in data)) put(nk, nv)
    if (k === 'updatedAt') out[k] = nowIso(now)
    else put(k, set.has(k) ? set.get(k) : v)
  }
  // Файл без createdAt не проходит схему, но на всякий случай новые поля не теряем.
  if (!('createdAt' in data)) for (const [nk, nv] of set) if (!(nk in data)) put(nk, nv)
  if (!('updatedAt' in out)) out.updatedAt = nowIso(now)
  return out as T
}

/** Значение поля так, как оно окажется в файле: отсутствие и null равны. */
const fieldOf = (obj: Record<string, unknown>, key: string) => (obj[key] === undefined ? null : obj[key])

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

export type Rebase = { kind: 'apply' } | { kind: 'already' } | { kind: 'conflict'; fields: (keyof ProjectPatch)[] }

/**
 * Файл изменился, пока правка шла на сервер. Правку можно наложить на свежую версию, если каждое её поле
 * там осталось таким, каким его видели при начале правки. Если все поля уже такие, как в правке, — писать нечего
 * (например, прошлая попытка дошла, а ответ потерялся).
 */
export function rebaseEdit(base: Record<string, unknown>, theirs: Record<string, unknown>, patch: ProjectPatch): Rebase {
  const keys = (Object.keys(patch) as (keyof ProjectPatch)[]).filter((k) => patch[k] !== undefined)
  if (keys.every((k) => sameValue(fieldOf(theirs, k), patch[k]))) return { kind: 'already' }
  const fields = keys.filter((k) => !sameValue(fieldOf(theirs, k), fieldOf(base, k)) && !sameValue(fieldOf(theirs, k), patch[k]))
  return fields.length ? { kind: 'conflict', fields } : { kind: 'apply' }
}

export const FIELD_LABEL: Record<keyof ProjectPatch, string> = {
  title: 'название',
  description: 'описание',
  stack: 'стек',
  tags: 'теги',
  status: 'статус',
  nextStep: 'следующий шаг',
  links: 'ссылки',
}

/** Правку не удалось наложить: эти поля успели поменять в другом месте. */
export class EditConflict extends Error {
  readonly fields: (keyof ProjectPatch)[]
  constructor(fields: (keyof ProjectPatch)[]) {
    super(`Пока правка шла, в другом месте поменяли ${fields.map((f) => FIELD_LABEL[f]).join(', ')}. Показаны свежие данные — внеси правку ещё раз.`)
    this.name = 'EditConflict'
    this.fields = fields
  }
}

// ---------- Ссылки ----------

export const LINK_KINDS = ['folder', 'repo', 'site', 'local', 'doc', 'other'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  folder: 'Папка на ПК',
  repo: 'Репозиторий',
  site: 'Сайт',
  local: 'Локальный URL',
  doc: 'Документ',
  other: 'Ссылка',
}

export const LINK_PLACEHOLDER: Record<LinkKind, string> = {
  folder: 'C:\\Users\\…\\project',
  repo: 'owner/name',
  site: 'https://…',
  local: 'http://localhost:5173',
  doc: 'https://…',
  other: 'https://…',
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const ABSOLUTE_PATH_RE = /^([A-Za-z]:[\\/]|\/)/

/** http(s)-адрес или null. Всё прочее (javascript:, data:, vscode: из файла…) ссылкой не становится. */
export function webUrl(value: string): string | null {
  try {
    const u = new URL(value.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** vscode://file/… для абсолютного пути; для относительного и странного — null. */
export function vscodeHref(path: string): string | null {
  const p = path.trim()
  if (!ABSOLUTE_PATH_RE.test(p) || [...p].some((c) => c.charCodeAt(0) < 0x20)) return null
  const segments = p.replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  return 'vscode://file/' + segments.map((s) => encodeURIComponent(s).replace(/^([A-Za-z])%3A$/, '$1:')).join('/')
}

/**
 * Куда ведёт ссылка из файла данных. Файл — недоверенный ввод (ADR-007, STRIDE): href бывает только
 * https:/http: и vscode://file/, собранный хабом из пути папки; остальное показывается текстом.
 */
export function linkHref(link: Pick<Link, 'kind' | 'value'>): string | null {
  if (link.kind === 'folder') return vscodeHref(link.value)
  if (link.kind === 'repo') return REPO_RE.test(link.value) ? `https://github.com/${link.value}` : null
  return webUrl(link.value)
}

/** Подпись ссылки: своя, иначе значение без протокола. */
export function linkText(link: Pick<Link, 'kind' | 'value' | 'label'>): string {
  if (link.label?.trim()) return link.label.trim()
  if (link.kind === 'folder' || link.kind === 'repo') return link.value
  return link.value.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export type NewLink = { ok: true; link: Link } | { ok: false; error: string }

/** Новая ссылка из формы: значение проверяется по виду так же, как это сделает схема. */
export function newLink(kind: LinkKind, rawValue: string, rawLabel: string): NewLink {
  const value = rawValue.trim()
  const label = oneLine(rawLabel)
  if (!value) return { ok: false, error: 'Нужно значение ссылки' }
  if (label.length > LINK_LABEL_MAX) return { ok: false, error: `Подпись длиннее ${LINK_LABEL_MAX} символов` }
  if (kind === 'folder' && !vscodeHref(value)) return { ok: false, error: 'Нужен полный путь к папке, например C:\\Users\\…' }
  if (kind === 'repo') {
    const short = value.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
    if (!REPO_RE.test(short)) return { ok: false, error: 'Репозиторий в виде owner/name' }
    return { ok: true, link: { id: ulid(), kind, value: short, ...(label ? { label } : {}) } }
  }
  // Схема требует у site/local/doc начало ровно https?:// — регистр важен.
  if (kind !== 'folder' && !(/^https?:\/\//.test(value) && webUrl(value))) return { ok: false, error: 'Нужен адрес, начинающийся с https:// или http://' }
  return { ok: true, link: { id: ulid(), kind, value, ...(label ? { label } : {}) } }
}
