// Страж выхода (ADR-004, ADR-007): выход стирает очередь правок и входящие конфликты этого устройства.
// Все кнопки выхода идут через confirmDataLoss: пусто — выход без вопроса; есть неотправленное или проверить
// не удалось — диалог SignOutGuardDialog, и выход только по явному «Стереть и выйти».
import { create } from 'zustand'
import { unsentSnapshot, useSession } from './session'
import { conflictCount } from '../screens/Conflicts'
import { buildUnsentExport, downloadJson, unsentFileName } from '../data/unsentExport'
import { getConflicts, getQueue, type QueuedEdit, type StoredConflict } from '../lib/localdb'
import { plural } from '../lib/plural'

/** Что стирается: только это устройство или выход везде (сервер завершит и остальные сессии). */
export type SignOutScope = 'device' | 'everywhere'

export interface UnsentCounts {
  edits: number
  conflicts: number
  /** Не удалось прочитать IndexedDB или устройство уже сообщило об ошибке: неотправленного может быть больше. */
  unknown?: boolean
}

/**
 * Ответ стража: `clean` — стирать нечего, вопрос не задавался; `erase` — владелец нажал «Стереть и выйти»;
 * `cancel` — выходить нельзя.
 */
export type GuardAnswer = 'clean' | 'erase' | 'cancel'

export interface SignOutAsk {
  /** Номер вопроса: новый вопрос — новый диалог (сброс «Файл скачан»). */
  id: number
  scope: SignOutScope
  counts: UnsentCounts
  resolve(answer: GuardAnswer): void
}

/** Открытый вопрос стража — его показывает SignOutGuardDialog (смонтирован в Shell). */
export const useSignOutGuard = create<{ ask: SignOutAsk | null }>(() => ({ ask: null }))

/** Сколько ждать IndexedDB: заблокированная база (другая вкладка на старой версии) не отвечает вовсе. */
export const DEVICE_READ_TIMEOUT_MS = 3000

export interface Unsent {
  edits: QueuedEdit[]
  conflicts: StoredConflict[]
  unknown: boolean
}

const keyOf = (x: { branch: string; path: string }) => JSON.stringify([x.branch, x.path])

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('IndexedDB не ответила')), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
    )
  })
}

/**
 * Всё неотправленное: память вкладки плюс IndexedDB, по ключу [ветка, путь] (память новее — она важнее).
 * Память может быть пуста, если чтение устройства при старте упало — поэтому IndexedDB дочитываем всегда.
 */
export async function collectUnsent(): Promise<Unsent> {
  const mem = unsentSnapshot()
  const edits = new Map(mem.edits.map((e) => [keyOf(e), e]))
  const conflicts = new Map(mem.conflicts.map((c) => [keyOf(c), c]))
  let unknown = useSession.getState().deviceError !== null
  try {
    const [q, c] = await withTimeout(Promise.all([getQueue(), getConflicts()]), DEVICE_READ_TIMEOUT_MS)
    for (const e of q) if (!edits.has(keyOf(e))) edits.set(keyOf(e), e)
    for (const x of c) if (!conflicts.has(keyOf(x))) conflicts.set(keyOf(x), x)
  } catch {
    unknown = true
  }
  return { edits: [...edits.values()], conflicts: [...conflicts.values()], unknown }
}

/** Сколько неотправленного на устройстве по всем веткам; конфликты считаются по спорным местам, как в меню. */
export async function unsentCounts(): Promise<UnsentCounts> {
  const u = await collectUnsent()
  return { edits: u.edits.length, conflicts: safeConflictCount(u.conflicts), unknown: u.unknown }
}

/** Как в меню, но битая запись (без `items`) считается одним конфликтом, а не роняет подсчёт. */
function safeConflictCount(list: readonly StoredConflict[]): number {
  try {
    return conflictCount(list)
  } catch {
    return list.reduce((n, c) => {
      try {
        return n + conflictCount([c])
      } catch {
        return n + 1
      }
    }, 0)
  }
}

/** «2 неотправленные правки и 1 конфликт сотрутся с этого устройства». */
export function unsentMessage({ edits, conflicts, unknown }: UnsentCounts): string {
  const parts: string[] = []
  if (edits > 0) parts.push(`${edits} ${plural(edits, 'неотправленная правка', 'неотправленные правки', 'неотправленных правок')}`)
  if (conflicts > 0) parts.push(`${conflicts} ${plural(conflicts, 'конфликт', 'конфликта', 'конфликтов')}`)
  const unsure = 'Не удалось проверить, что на устройстве'
  if (!parts.length) return `${unsure}: неотправленные правки и конфликты, если они есть, сотрутся.`
  const single = parts.length === 1 ? edits || conflicts : 0
  const verb = single ? plural(single, 'сотрётся', 'сотрутся', 'сотрутся') : 'сотрутся'
  const main = `${parts.join(' и ')} ${verb} с этого устройства.`
  return unknown ? `${main} ${unsure} — может быть и больше.` : main
}

let askSeq = 0

/** Спросить перед стиранием устройства. Второй вопрос поверх открытого закрывает первый отказом. */
export async function confirmDataLoss(scope: SignOutScope): Promise<GuardAnswer> {
  let counts: UnsentCounts
  try {
    counts = await unsentCounts()
  } catch {
    counts = { edits: 0, conflicts: 0, unknown: true }
  }
  if (counts.edits === 0 && counts.conflicts === 0 && !counts.unknown) return 'clean'
  return new Promise((resolve) => {
    useSignOutGuard.getState().ask?.resolve('cancel')
    useSignOutGuard.setState({ ask: { id: ++askSeq, scope, counts, resolve } })
  })
}

/** Ответ из диалога: закрыть вопрос и отдать ответ ждущей кнопке. */
export function answerSignOut(erase: boolean): void {
  const ask = useSignOutGuard.getState().ask
  if (!ask) return
  useSignOutGuard.setState({ ask: null })
  ask.resolve(erase ? 'erase' : 'cancel')
}

/** «Скачать неотправленное»: свежий снимок памяти и IndexedDB в JSON. Из диалога не выходит. */
export async function downloadUnsent(now = new Date()): Promise<{ unknown: boolean }> {
  const u = await collectUnsent()
  downloadJson(unsentFileName(now), buildUnsentExport(u.edits, u.conflicts, now))
  return { unknown: u.unknown }
}

/** Выход с этого устройства через стража: signOut только если стирать нечего или владелец согласился. */
export async function guardedSignOut(signOut: () => Promise<void>): Promise<boolean> {
  if ((await confirmDataLoss('device')) === 'cancel') return false
  await signOut()
  return true
}
