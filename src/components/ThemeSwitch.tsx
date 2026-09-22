import { useEffect, useState } from 'react'
import { CircleHalf, Moon, Sun } from '@phosphor-icons/react'
import css from './ThemeSwitch.module.css'

type Theme = 'auto' | 'dark' | 'light'
const KEY = 'tartaluga.theme'

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'auto', label: 'Как в системе', icon: CircleHalf },
  { value: 'dark', label: 'Тёмная', icon: Moon },
  { value: 'light', label: 'Светлая', icon: Sun },
]

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* приватный режим: тема просто не запомнится */
    }
  }, [theme])

  return (
    <div className={css.group} role="radiogroup" aria-label="Тема">
      {OPTIONS.map(({ value, label, icon: IconCmp }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          className={css.btn}
          onClick={() => setTheme(value)}
        >
          <IconCmp size={18} aria-hidden />
        </button>
      ))}
    </div>
  )
}
