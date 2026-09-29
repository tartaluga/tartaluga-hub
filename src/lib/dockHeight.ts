/** Имя CSS-переменной с высотой нижнего дока телефона (полоска синхронизации + вкладки). */
export const DOCK_VAR = '--dock-h'

/**
 * Callback-ref для дока: держит `--dock-h` на documentElement равной его высоте (CSSOM, не атрибут style — CSP разрешает).
 * Плашки поверх интерфейса (UpdateNotice) встают над доком при любой его высоте. На ПК док скрыт — переменная 0.
 */
export function trackDockHeight(el: HTMLElement | null): (() => void) | void {
  if (!el || typeof ResizeObserver === 'undefined') return
  const root = document.documentElement
  const apply = () => root.style.setProperty(DOCK_VAR, `${el.offsetHeight}px`)
  apply()
  const ro = new ResizeObserver(apply)
  ro.observe(el)
  return () => {
    ro.disconnect()
    root.style.removeProperty(DOCK_VAR)
  }
}
