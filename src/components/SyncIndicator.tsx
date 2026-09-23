import { useEffect, useState } from 'react'
import { useSession } from '../app/session'
import css from './SyncIndicator.module.css'

function ago(date: Date, now: number): string {
  const min = Math.floor((now - date.getTime()) / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} ч назад` : date.toLocaleDateString('ru-RU')
}

/** «SYNC · 2 мин назад» внизу боковой панели. Нажатие — синхронизировать сейчас. */
export function SyncIndicator() {
  const sync = useSession((s) => s.sync)
  const lastSync = useSession((s) => s.lastSync)
  const syncError = useSession((s) => s.syncError)
  const refresh = useSession((s) => s.refresh)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const text =
    sync === 'syncing'
      ? 'SYNC · обновляю…'
      : sync === 'offline'
        ? 'OFFLINE · данные из кэша'
        : sync === 'error'
          ? 'SYNC · ошибка'
          : lastSync
            ? `SYNC · ${ago(lastSync, now)}`
            : 'SYNC · ещё не было'

  return (
    <button type="button" className={css.sync} data-state={sync} onClick={() => void refresh()} title={syncError ?? 'Обновить данные сейчас'}>
      <span className={css.dot} aria-hidden />
      <span className="mono">{text}</span>
    </button>
  )
}
