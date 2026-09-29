import { useEffect, useState } from 'react'
import { useSession } from '../app/session'
import { syncText } from './SyncIndicator'
import css from './MobileSyncBar.module.css'

type State = ReturnType<typeof useSession.getState>['sync']

/** Полоска на телефоне нужна, только когда есть что сказать: очередь, нет сети, ошибка, вход, ошибка устройства. */
export function syncBarVisible(sync: State, queued: number, deviceError: string | null): boolean {
  return queued > 0 || sync === 'offline' || sync === 'error' || sync === 'sessionExpired' || Boolean(deviceError)
}

/** Состояние синхронизации над нижней панелью вкладок (боковой панели с индикатором на телефоне нет). */
export function MobileSyncBar() {
  const sync = useSession((s) => s.sync)
  const lastSync = useSession((s) => s.lastSync)
  const syncError = useSession((s) => s.syncError)
  const queued = useSession((s) => s.queued)
  const syncNow = useSession((s) => s.syncNow)
  const deviceError = useSession((s) => s.deviceError)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  if (!syncBarVisible(sync, queued, deviceError)) return null
  const state = queued && sync === 'idle' ? 'queued' : sync

  return (
    <div className={css.bar}>
      {(sync !== 'idle' || queued > 0) && (
        <button type="button" className={css.sync} data-state={state} onClick={() => void syncNow()} title={syncError ?? 'Обновить данные и отправить правки сейчас'}>
          <span className={css.dot} aria-hidden />
          <span className="mono">{syncText(sync, queued, lastSync, now)}</span>
        </button>
      )}
      {deviceError && (
        <p className={css.device} role="alert">
          <span className={css.dot} aria-hidden />
          <span>{deviceError}</span>
        </p>
      )}
    </div>
  )
}
