import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import css from './UpdateBanner.module.css'

// Новая версия приложения не подменяет старую молча (ADR-006): показываем плашку,
// обновление — по нажатию. Проверяем наличие новой версии раз в час.
export function UpdateBanner() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // При повторной регистрации (например, после обновления) не плодим параллельные таймеры.
      if (intervalRef.current !== undefined) clearInterval(intervalRef.current)
      intervalRef.current = reg ? setInterval(() => void reg.update(), 60 * 60 * 1000) : undefined
    },
  })

  useEffect(
    () => () => {
      if (intervalRef.current !== undefined) clearInterval(intervalRef.current)
    },
    [],
  )

  if (!needRefresh) return null
  return (
    <div className={css.banner} role="status">
      <span>Доступна новая версия хаба</span>
      <button type="button" className={css.primary} onClick={() => void updateServiceWorker(true)}>
        Обновить
      </button>
      <button type="button" className={css.ghost} onClick={() => setNeedRefresh(false)}>
        Позже
      </button>
    </div>
  )
}
