import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { ACCESS_HINT, useSession } from '../app/session'
import { syncText } from './SyncIndicator'
import css from './MobileSyncBar.module.css'

type State = ReturnType<typeof useSession.getState>['sync']

/** Полоска на телефоне нужна, только когда есть что сказать: очередь, нет сети, ошибка, вход, ошибка устройства, нет доступа к GitHub. */
export function syncBarVisible(sync: State, queued: number, deviceError: string | null, accessProblem: boolean): boolean {
  return queued > 0 || sync === 'offline' || sync === 'error' || sync === 'sessionExpired' || Boolean(deviceError) || accessProblem
}

const QUERY = '(max-width: 767px)'

/** Телефонная ширина: подписка на смену (поворот экрана, изменение окна). */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const on = () => setMobile(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}

/** Состояние синхронизации над нижней панелью вкладок (боковой панели с индикатором на телефоне нет). */
export function MobileSyncBar() {
  const sync = useSession((s) => s.sync)
  const lastSync = useSession((s) => s.lastSync)
  const syncError = useSession((s) => s.syncError)
  const queued = useSession((s) => s.queued)
  const syncNow = useSession((s) => s.syncNow)
  const deviceError = useSession((s) => s.deviceError)
  const accessProblem = useSession((s) => s.accessProblem)
  const [now, setNow] = useState(() => Date.now())
  const mobile = useIsMobile()
  const { pathname } = useLocation()
  // В «Настройках» на телефоне уже полный индикатор — второй такой же не нужен.
  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/')
  const base = syncBarVisible(sync, queued, deviceError, accessProblem)
  // Без прыжка: если полоска была видна, во время сверки она остаётся до её конца.
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (base) setHeld(true)
    else if (sync !== 'syncing') setHeld(false)
  }, [base, sync])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  if (!mobile || onSettings || !(base || (held && sync === 'syncing'))) return null
  const state = queued && sync === 'idle' ? 'queued' : sync

  return (
    <div className={css.bar}>
      {(sync !== 'idle' || queued > 0) && (
        <button type="button" className={css.sync} data-state={state} onClick={() => void syncNow()} title={syncError ?? 'Обновить данные и отправить правки сейчас'}>
          <span className={css.dot} aria-hidden />
          <span className={css.text}>
            <span className="mono">{syncText(sync, queued, lastSync, now)}</span>
            {sync === 'error' && syncError && syncError !== ACCESS_HINT && <span className={css.reason}>{syncError}</span>}
          </span>
        </button>
      )}
      {accessProblem && (
        <p className={css.device} role="alert">
          <span className={css.dot} aria-hidden />
          <span>{ACCESS_HINT}</span>
        </p>
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
