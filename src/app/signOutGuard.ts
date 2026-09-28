// Страж выхода (ADR-004, ADR-007): выход стирает очередь правок и входящие конфликты этого устройства.
// Все кнопки выхода идут через confirmDataLoss: пусто — выход без вопроса; есть неотправленное —
// диалог SignOutGuardDialog, и выход только по явному «Стереть и выйти».
import { create } from 'zustand'
import { unsentSnapshot } from './session'
import { conflictCount } from '../screens/Conflicts'
import { buildUnsentExport, downloadJson, unsentFileName } from '../data/unsentExport'
import { plural } from '../lib/plural'

/** Что стирается: только это устройство или выход везде (сервер завершит и остальные сессии). */
export type SignOutScope = 'device' | 'everywhere'

export interface UnsentCounts {
  edits: number
  conflicts: number
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

/** Сколько неотправленного на устройстве по всем веткам; конфликты считаются по спорным местам, как в меню. */
export function unsentCounts(): UnsentCounts {
  const snap = unsentSnapshot()
  return { edits: snap.edits.length, conflicts: conflictCount(snap.conflicts) }
}

/** «2 неотправленные правки и 1 конфликт сотрутся с этого устройства». */
export function unsentMessage({ edits, conflicts }: UnsentCounts): string {
  const parts: string[] = []
  if (edits > 0) parts.push(`${edits} ${plural(edits, 'неотправленная правка', 'неотправленные правки', 'неотправленных правок')}`)
  if (conflicts > 0) parts.push(`${conflicts} ${plural(conflicts, 'конфликт', 'конфликта', 'конфликтов')}`)
  const single = parts.length === 1 ? (edits || conflicts) : 0
  const verb = single ? plural(single, 'сотрётся', 'сотрутся', 'сотрутся') : 'сотрутся'
  return `${parts.join(' и ')} ${verb} с этого устройства.`
}

let askSeq = 0

/** Спросить перед стиранием устройства. Второй вопрос поверх открытого закрывает первый отказом. */
export function confirmDataLoss(scope: SignOutScope): Promise<GuardAnswer> {
  const counts = unsentCounts()
  if (counts.edits === 0 && counts.conflicts === 0) return Promise.resolve('clean')
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

/** «Скачать неотправленное»: свежий снимок очереди и конфликтов в JSON. Из диалога не выходит. */
export function downloadUnsent(now = new Date()): void {
  const snap = unsentSnapshot()
  downloadJson(unsentFileName(now), buildUnsentExport(snap.edits, snap.conflicts, now))
}

/** Выход с этого устройства через стража: signOut только если стирать нечего или владелец согласился. */
export async function guardedSignOut(signOut: () => Promise<void>): Promise<boolean> {
  if ((await confirmDataLoss('device')) === 'cancel') return false
  await signOut()
  return true
}
