import { useSyncExternalStore } from 'react'
import { CircleHalf, Moon, Sun } from '@phosphor-icons/react'
import css from './ThemeSwitch.module.css'

export type Theme = 'auto' | 'dark' | 'light'
const KEY = 'tartaluga.theme'

/** Цвет полосы браузера и системной панели (meta theme-color) — фон темы из tokens.css. */
export const THEME_COLOR = { dark: '#161826', light: '#f3f2f9' } as const

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * meta theme-color в index.html две: для тёмной и светлой системной темы (media).
 * Ручная тема ставит свой цвет в обе, «как в системе» — возвращает каждой её собственный.
 */
export function syncThemeColor(theme: Theme, doc: Pick<Document, 'querySelectorAll'> = document) {
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = (meta.getAttribute('media') ?? '').includes('light') ? THEME_COLOR.light : THEME_COLOR.dark
    meta.setAttribute('content', theme === 'auto' ? own : THEME_COLOR[theme])
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  syncThemeColor(theme)
}

// Одна тема на всё приложение: переключатели в боковой панели и в настройках видят одно и то же.
let current: Theme = 'auto'
const listeners = new Set<() => void>()

function setTheme(theme: Theme) {
  current = theme
  if (typeof document !== 'undefined') applyTheme(theme)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* приватный режим: тема просто не запомнится */
  }
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const getTheme = () => current

if (typeof document !== 'undefined') {
  current = readTheme()
  applyTheme(current)
}

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'auto', label: 'Как в системе', icon: CircleHalf },
  { value: 'dark', label: 'Тёмная', icon: Moon },
  { value: 'light', label: 'Светлая', icon: Sun },
]

export function ThemeSwitch({ withLabels }: { withLabels?: boolean }) {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme)

  return (
    <div className={css.group} role="radiogroup" aria-label="Тема">
      {OPTIONS.map(({ value, label, icon: IconCmp }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={withLabels ? undefined : label}
          title={label}
          className={css.btn}
          onClick={() => setTheme(value)}
        >
          <IconCmp size={18} aria-hidden />
          {withLabels && <span>{label}</span>}
        </button>
      ))}
    </div>
  )
}
