import { useRegisterSW } from 'virtual:pwa-register/react'
import css from './UpdateBanner.module.css'

// Новая версия приложения не подменяет старую молча (ADR-006): показываем плашку,
// обновление — по нажатию. Проверяем наличие новой версии раз в час.
export function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setInterval(() => void reg.update(), 60 * 60 * 1000)
    },
  })

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
