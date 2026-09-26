import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useSession } from '../app/session'
import { plural } from '../lib/plural'
import { conflictCount } from '../screens/Conflicts'
import css from './SyncIndicator.module.css'

function ago(date: Date, now: number): string {
  const min = Math.floor((now - date.getTime()) / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} ч назад` : date.toLocaleDateString('ru-RU')
}

type State = ReturnType<typeof useSession.getState>['sync']

/** Текст индикатора (ADR-004, ADR-010 §4, макет 5-6a): сессия, очередь правок, сеть, последняя сверка. */
export function syncText(sync: State, queued: number, lastSync: Date | null, now: number): string {
  const edits = `${queued} ${plural(queued, 'правка', 'правки', 'правок')}`
  if (sync === 'sessionExpired') return 'НУЖЕН ВХОД · сессия истекла'
  if (sync === 'syncing') return 'SYNC · обновляю…'
  if (sync === 'offline') return queued ? `OFFLINE · ${edits} на устройстве` : 'OFFLINE · данные из кэша'
  if (sync === 'error') return queued ? `ошибка · ${edits} в очереди` : 'SYNC · ошибка'
  if (queued) return `${edits} ${plural(queued, 'ждёт', 'ждут', 'ждут')} отправки`
  return lastSync ? `сохранено · ${ago(lastSync, now)}` : 'SYNC · ещё не было'
}

/** Строка «Входящих конфликтов» под индикатором: пусто, если разбирать нечего. */
export function conflictText(count: number): string | null {
  return count > 0 ? `${count} ${plural(count, 'конфликт', 'конфликта', 'конфликтов')} · разобрать` : null
}

/** «SYNC · 2 мин назад» внизу боковой панели. Нажатие — сверить данные и отправить очередь сейчас. */
export function SyncIndicator() {
  const sync = useSession((s) => s.sync)
  const lastSync = useSession((s) => s.lastSync)
  const syncError = useSession((s) => s.syncError)
  const queued = useSession((s) => s.queued)
  const syncNow = useSession((s) => s.syncNow)
  const conflictList = useSession((s) => s.conflicts)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const text = syncText(sync, queued, lastSync, now)
  // Очередь видна отдельным состоянием, пока нет более важного (вход, нет сети, ошибка, идёт сверка).
  const state = queued && sync === 'idle' ? 'queued' : sync

  const conflicts = conflictText(conflictCount(conflictList))

  return (
    <div className={css.wrap}>
      <button type="button" className={css.sync} data-state={state} onClick={() => void syncNow()} title={syncError ?? 'Обновить данные и отправить правки сейчас'}>
        <span className={css.dot} aria-hidden />
        <span className="mono">{text}</span>
      </button>
      {conflicts && (
        <Link to="/conflicts" className={css.conflicts}>
          <span className={css.dot} aria-hidden />
          <span className="mono">{conflicts}</span>
        </Link>
      )}
    </div>
  )
}
