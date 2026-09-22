import { NavLink, Outlet } from 'react-router'
import { ChartBar, Lightbulb, SquaresFour, SunHorizon } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { Visor } from '../components/Visor'
import { ThemeSwitch } from '../components/ThemeSwitch'
import css from './Shell.module.css'

const NAV: { to: string; label: string; icon: Icon }[] = [
  { to: '/', label: 'Сегодня', icon: SunHorizon },
  { to: '/projects', label: 'Проекты', icon: SquaresFour },
  { to: '/ideas', label: 'Идеи', icon: Lightbulb },
  { to: '/stats', label: 'Статистика', icon: ChartBar },
]

export function Shell() {
  return (
    <div className={css.shell}>
      <aside className={css.side}>
        <div className={css.brand}>
          <Visor />
          <div>
            <div className={css.brandName}>Tartaluga</div>
            <div className={css.brandSub}>HUB</div>
          </div>
        </div>
        <nav className={css.nav} aria-label="Разделы">
          {NAV.map(({ to, label, icon: IconCmp }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? `${css.link} ${css.active}` : css.link)}>
              <IconCmp size={20} aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={css.sideFoot}>
          <div className={css.sync}>
            <span className={css.syncDot} aria-hidden />
            <span className="mono">SYNC · не подключено</span>
          </div>
          <ThemeSwitch />
        </div>
      </aside>

      <main className={css.main}>
        <Outlet />
      </main>

      <nav className={css.bottom} aria-label="Разделы">
        {NAV.map(({ to, label, icon: IconCmp }) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? `${css.tab} ${css.active}` : css.tab)}>
            <IconCmp size={22} aria-hidden />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
