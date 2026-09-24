// Правки settings.json как чистые функции «было → стало». Сессия применяет их к свежей версии файла,
// поэтому при конфликте (файл изменили на другом устройстве) правка просто накладывается ещё раз.
// Незнакомые поля файла и тегов проходят насквозь (ADR-003, правило 1).
import { parseFile, slugify, type WithUnknown } from '../data/model'
import { DEFAULT_ABANDONED_DAYS } from '../data/projects'
import type { Settings } from '../schema/types'

export type SettingsData = WithUnknown<Settings>
export type Tag = Settings['tags'][number]
export type SettingsChange = (current: SettingsData) => SettingsData

/** Палитра тегов: цвета Визора. В файле — #rrggbb, как требует схема. */
export const PALETTE: { color: string; label: string }[] = [
  { color: '#9184d9', label: 'сиреневый' },
  { color: '#d472b2', label: 'маджента' },
  { color: '#6fc2b4', label: 'бирюзовый' },
  { color: '#d9b36a', label: 'охра' },
  { color: '#9dbb7a', label: 'зелёный' },
  { color: '#7ba6dc', label: 'голубой' },
  { color: '#8a8fa6', label: 'серый' },
]

export const TAG_NAME_MAX = 32
export const DAYS_MIN = 1
export const DAYS_MAX = 365

const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ')
const norm = (s: string) => oneLine(s).toLocaleLowerCase('ru').replace(/ё/g, 'е')

/** Ошибка для человека или null, если имя подходит. exceptId — тег, который переименовываем. */
export function tagNameError(name: string, tags: Tag[], exceptId?: string): string | null {
  const clean = oneLine(name)
  if (!clean) return 'Название не может быть пустым'
  if (clean.length > TAG_NAME_MAX) return `Не длиннее ${TAG_NAME_MAX} символов`
  if (tags.some((t) => t.id !== exceptId && norm(t.name) === norm(clean))) return 'Такой тег уже есть'
  return null
}

/** Постоянный id нового тега из названия: латиница, цифры, дефисы; занятый — с суффиксом -2, -3… */
export function newTagId(name: string, taken: Iterable<string>): string {
  const slug = slugify(name)
  // slugify отдаёт 'project', когда из названия ничего не осталось (например, одни эмодзи).
  const base = slug === 'project' && !/project/i.test(name) ? 'tag' : slug
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`
}

/** Следующий цвет палитры, которого ещё нет у тегов (если все заняты — по кругу). */
export function nextColor(tags: Tag[]): string {
  const used = new Set(tags.map((t) => t.color.toLowerCase()))
  return (PALETTE.find((p) => !used.has(p.color)) ?? PALETTE[tags.length % PALETTE.length]!).color
}

const mapTag = (id: string, fn: (t: Tag) => Tag): SettingsChange => (s) => ({ ...s, tags: s.tags.map((t) => (t.id === id ? fn(t) : t)) })

export const renameTag = (id: string, name: string): SettingsChange => mapTag(id, (t) => ({ ...t, name: oneLine(name) }))

export const recolorTag = (id: string, color: string): SettingsChange => mapTag(id, (t) => ({ ...t, color }))

export const removeTag = (id: string): SettingsChange => (s) => ({ ...s, tags: s.tags.filter((t) => t.id !== id) })

/**
 * Новый тег в конец списка. id выбирается при каждом применении по свежему файлу:
 * если тег с таким именем уже появился (повтор записи или другое устройство) — второй не создаём.
 */
export const addTag = (name: string, color: string): SettingsChange => (s) => {
  const clean = oneLine(name)
  if (s.tags.some((t) => norm(t.name) === norm(clean))) return s
  return { ...s, tags: [...s.tags, { id: newTagId(clean, s.tags.map((t) => t.id)), name: clean, color }] }
}

/** Поставить тег на место index (по списку без него). Тега уже нет — ничего не меняем. */
export const moveTag = (id: string, index: number): SettingsChange => (s) => {
  const from = s.tags.findIndex((t) => t.id === id)
  if (from < 0) return s
  const rest = s.tags.filter((t) => t.id !== id)
  const to = Math.max(0, Math.min(rest.length, index))
  return { ...s, tags: [...rest.slice(0, to), s.tags[from]!, ...rest.slice(to)] }
}

export const clampDays = (n: number) => Math.max(DAYS_MIN, Math.min(DAYS_MAX, Math.round(n)))

export const setAbandonedDays = (days: number): SettingsChange => (s) => ({ ...s, abandonedAfterDays: clampDays(days) })

/**
 * Куда встанет перетаскиваемый элемент: индекс в списке без него.
 * mids — середины строк по вертикали (в порядке списка), y — где сейчас палец или курсор.
 */
export function dropIndex(mids: number[], from: number, y: number): number {
  let index = 0
  mids.forEach((mid, i) => {
    if (i !== from && y > mid) index++
  })
  return index
}

/** Что показать из settings.json: данные и можно ли их править. */
export function readSettings(file: { sha: string; text: string } | undefined): { tags: Tag[]; days: number; problem: string | null } {
  if (!file) return { tags: [], days: DEFAULT_ABANDONED_DAYS, problem: null }
  const parsed = parseFile('settings.json', file.sha, file.text)
  if (!parsed.ok) return { tags: [], days: DEFAULT_ABANDONED_DAYS, problem: `settings.json не читается: ${parsed.error}. Поправь файл в репо данных — до тех пор настройки только для чтения.` }
  const data = parsed.data as SettingsData
  return { tags: data.tags, days: data.abandonedAfterDays ?? DEFAULT_ABANDONED_DAYS, problem: parsed.readOnly ? parsed.reason : null }
}
