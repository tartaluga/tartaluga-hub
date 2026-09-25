// Незаконченная работа через обновление хаба (ADR-011 §4, §6).
// Экран с полем ввода отдаёт текст через useDraft; перед перезагрузкой на новую версию всё собирается
// в запись handoff (IndexedDB), новая версия прогоняет её через миграции и возвращает черновики на место.
// Если перенести не удалось — ничего не выбрасываем: запись уходит в handoff-failed, текст показывается для копирования.
import { openDB, type IDBPDatabase } from 'idb'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { migrateState, STATE_VERSION } from '../app/migrations'

export interface Draft {
  /** Стабильный ключ поля, например `project:<slug>:summary` или `new-project:title`. */
  key: string
  /** Подпись для человека — видна, если черновик придётся копировать руками. */
  label: string
  text: string
}

export interface HandoffUi {
  scrollY: number
}

export interface Handoff {
  stateVersion: number
  build: string
  at: number
  /** Адрес экрана — hash, например `#/projects/hub`. */
  route: string
  drafts: Draft[]
  ui: HandoffUi
}

export const HANDOFF_KEY = 'handoff'
export const FAILED_KEY = 'handoff-failed'
/** Запись старше суток не восстанавливает экран, но черновики из неё остаются (ADR-011 §4). */
export const SCREEN_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ROUTE = 2048

// ---------- Хранилище ----------

export interface StateStore {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Отдельная база: схема основной (localdb.ts) меняется своим upgrade, а открывать её без версии небезопасно.
 * На «Выйти» её стирает Clear-Site-Data с сервера и wipeDrafts().
 */
export const STATE_DB = 'tartaluga-hub-state'
let statePromise: Promise<IDBPDatabase> | null = null

function stateDb() {
  statePromise ??= openDB(STATE_DB, 1, {
    upgrade(d) {
      d.createObjectStore('kv')
    },
  })
  return statePromise
}

export function idbStateStore(): StateStore {
  return {
    get: async (key) => (await stateDb()).get('kv', key),
    put: async (key, value) => {
      await (await stateDb()).put('kv', value, key)
    },
    delete: async (key) => {
      await (await stateDb()).delete('kv', key)
    },
  }
}

/** «Выйти»: стереть черновики с устройства. */
export async function wipeDrafts(): Promise<void> {
  if (statePromise) (await statePromise).close()
  statePromise = null
  live.clear()
  restored.clear()
  setRescue(null)
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(STATE_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

// ---------- Реестр черновиков ----------

/** Черновики, открытые на экране сейчас. */
const live = new Map<string, Draft>()
/** Черновики, пришедшие от прошлой версии и ещё не подхваченные экраном. */
const restored = new Map<string, Draft>()

export function setDraft(key: string, label: string, text: string): void {
  live.set(key, { key, label, text })
  // Экран подхватил поле — дальше его текст живой, старый не нужен.
  restored.delete(key)
}

export function clearDraft(key: string): void {
  live.delete(key)
}

export function restoredDraft(key: string): string | undefined {
  return restored.get(key)?.text
}

export function discardRestoredDraft(key: string): void {
  restored.delete(key)
}

/** Сбросить реестр (тесты). */
export function resetDrafts(): void {
  live.clear()
  restored.clear()
  setRescue(null)
}

/**
 * Черновик поля. `key` — null, если поле черновики не отдаёт. `text` — текущий текст, пока поле открыто
 * на правку; `undefined` — поле закрыто или текст не менялся.
 * `restored` — текст, пришедший от прошлой версии: открой с ним поле на правку и после сохранения/отмены вызови `discard`.
 */
export function useDraft(key: string | null, text: string | undefined, label: string): { restored: string | undefined; discard: () => void } {
  const [state, setState] = useState(() => ({ key, text: key === null ? undefined : restoredDraft(key) }))
  const current = key === null ? undefined : state.key === key ? state.text : restoredDraft(key)

  useEffect(() => {
    if (key === null) return
    if (text === undefined) {
      clearDraft(key)
      return
    }
    setDraft(key, label, text)
    return () => clearDraft(key)
  }, [key, label, text])

  const discard = useCallback(() => {
    if (key === null) return
    discardRestoredDraft(key)
    setState({ key, text: undefined })
  }, [key])

  return { restored: current, discard }
}

/**
 * Всегда открытое поле (запись в лог, «добавить в стек»): текст стартует с черновика прошлой версии,
 * непустой текст отдаётся в handoff. Очистил поле после сохранения — черновика больше нет.
 */
export function useDraftText(key: string, label: string): [string, (next: string | ((cur: string) => string)) => void] {
  const [text, setText] = useState(() => restoredDraft(key) ?? '')
  useDraft(key, text === '' ? undefined : text, label)
  return [text, setText]
}

// ---------- handoff ----------

export function buildHandoff(input: { route: string; scrollY: number; now: number; build: string }): Handoff {
  // Не подхваченные экраном черновики прошлой версии тоже едут дальше — иначе второе обновление подряд их потеряет.
  const drafts = [...[...restored.values()].filter((d) => !live.has(d.key)), ...live.values()].map((d) => ({ ...d }))
  return {
    stateVersion: STATE_VERSION,
    build: input.build,
    at: input.now,
    route: input.route,
    drafts,
    ui: { scrollY: Math.max(0, Math.round(input.scrollY) || 0) },
  }
}

export async function saveHandoff(store: StateStore, input: Parameters<typeof buildHandoff>[0]): Promise<void> {
  await store.put(HANDOFF_KEY, buildHandoff(input))
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Проверка формата текущей версии после миграций. Бросает, если запись не такая, как ждём. */
export function parseHandoff(x: unknown): Handoff {
  if (!isObject(x)) throw new Error('handoff не объект')
  const { build, at, route, drafts, ui } = x
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new Error('handoff.at')
  if (typeof build !== 'string') throw new Error('handoff.build')
  if (typeof route !== 'string') throw new Error('handoff.route')
  if (!Array.isArray(drafts)) throw new Error('handoff.drafts')
  const parsed = drafts.map((d, i) => {
    if (!isObject(d) || typeof d.key !== 'string' || typeof d.label !== 'string' || typeof d.text !== 'string') throw new Error(`handoff.drafts[${i}]`)
    return { key: d.key, label: d.label, text: d.text }
  })
  const scrollY = isObject(ui) && typeof ui.scrollY === 'number' && Number.isFinite(ui.scrollY) ? Math.max(0, ui.scrollY) : 0
  return { stateVersion: STATE_VERSION, build, at, route, drafts: parsed, ui: { scrollY } }
}

/** Адрес из handoff — только наш hash-маршрут; всё прочее игнорируем. Возвращает путь для роутера: `/projects/hub`. */
export function safeRoute(route: string): string | undefined {
  if (route.length > MAX_ROUTE || !route.startsWith('#/') || route.startsWith('#//')) return undefined
  for (const ch of route) if (ch < ' ' || ch === '\\' || ch === '\u007f') return undefined
  return route.slice(1)
}

/** Текст всех черновиков из записи любого (в том числе незнакомого) формата — для ручного копирования. */
export function rescueText(raw: unknown): string {
  const drafts = isObject(raw) ? raw.drafts : undefined
  if (Array.isArray(drafts)) {
    const parts = drafts.flatMap((d) => {
      if (!isObject(d)) return []
      const text = typeof d.text === 'string' ? d.text : typeof d.value === 'string' ? d.value : undefined
      if (text === undefined || text === '') return []
      const label = typeof d.label === 'string' && d.label ? d.label : typeof d.key === 'string' ? d.key : 'Черновик'
      return [`${label}\n${text}`]
    })
    if (parts.length) return parts.join('\n\n')
  }
  try {
    return JSON.stringify(raw, null, 2) ?? ''
  } catch {
    return String(raw)
  }
}

export interface RestoreResult {
  /** Куда вернуть экран (путь роутера); нет — оставить как есть. */
  route?: string
  ui?: HandoffUi
  drafts: Draft[]
  /** Перенос не удался — показан текст для копирования. */
  failed: boolean
}

/** Новая версия при запуске: прочитать handoff, прогнать миграции, вернуть черновики в реестр, удалить запись. */
export async function restoreHandoff(store: StateStore, now: number): Promise<RestoreResult> {
  const previousFailure = await store.get(FAILED_KEY)
  if (previousFailure !== undefined) setRescue(rescueText(previousFailure))

  const raw = await store.get(HANDOFF_KEY)
  if (raw === undefined) return { drafts: [], failed: false }

  let handoff: Handoff
  try {
    handoff = parseHandoff(migrateState(raw, isObject(raw) ? raw.stateVersion : undefined))
  } catch (e) {
    console.warn('handoff не перенесён:', e instanceof Error ? e.message : e)
    // Прошлую неудачу не затираем: складываем обе, чтобы ничего не потерять.
    await store.put(FAILED_KEY, previousFailure === undefined ? raw : { drafts: [...draftsOf(previousFailure), ...draftsOf(raw)] })
    await store.delete(HANDOFF_KEY)
    setRescue(rescueText(await store.get(FAILED_KEY)))
    return { drafts: [], failed: true }
  }

  for (const d of handoff.drafts) if (!live.has(d.key)) restored.set(d.key, d)
  await store.delete(HANDOFF_KEY)

  const fresh = handoff.at <= now && now - handoff.at <= SCREEN_TTL_MS
  if (!fresh) return { drafts: handoff.drafts, failed: false }
  const route = safeRoute(handoff.route)
  return { ...(route ? { route } : {}), ui: handoff.ui, drafts: handoff.drafts, failed: false }
}

function draftsOf(raw: unknown): unknown[] {
  if (isObject(raw) && Array.isArray(raw.drafts)) return raw.drafts
  return [{ label: 'Запись целиком', text: rescueText(raw) }]
}

// ---------- «Не удалось перенести черновик» ----------

let rescue: string | null = null
const rescueListeners = new Set<() => void>()

function setRescue(text: string | null): void {
  rescue = text
  for (const l of rescueListeners) l()
}

export function getRescue(): string | null {
  return rescue
}

export function subscribeRescue(fn: () => void): () => void {
  rescueListeners.add(fn)
  return () => rescueListeners.delete(fn)
}

export function useRescue(): string | null {
  return useSyncExternalStore(subscribeRescue, getRescue, getRescue)
}

/** Владелец скопировал текст — убрать запись и плашку. */
export async function dismissRescue(store: StateStore): Promise<void> {
  await store.delete(FAILED_KEY)
  setRescue(null)
}
