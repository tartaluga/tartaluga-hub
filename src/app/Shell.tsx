import { useEffect } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { ChartBar, Lightbulb, ShieldCheck, SignOut, SquaresFour, SunHorizon } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { Visor } from '../components/Visor'
import { ThemeSwitch } from '../components/ThemeSwitch'
import { SyncIndicator } from '../components/SyncIndicator'
import { SecurityBanner } from '../components/SecurityBanner'
import { Login } from '../screens/Login'
import { useSession } from './session'
import css from './Shell.module.css'

const NAV: { to: string; label: string; icon: Icon }[] = [
  { to: '/', label: 'Сегодня', icon: SunHorizon },
  { to: '/projects', label: 'Проекты', icon: SquaresFour },
  { to: '/ideas', label: 'Идеи', icon: Lightbulb },
  { to: '/stats', label: 'Статистика', icon: ChartBar },
]

export function Shell() {
  const phase = useSession((s) => s.phase)
  const sync = useSession((s) => s.sync)
  const boot = useSession((s) => s.boot)
  const signOut = useSession((s) => s.signOut)

  useEffect(() => {
    void boot()
  }, [boot])

  // Проверяем свежесть данных, когда пользователь возвращается в приложение.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void useSession.getState().refresh()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
    }
  }, [])

  if (phase === 'booting') return <div className={css.boot} aria-hidden><Visor size={72} /></div>
  if (phase === 'signedOut') return <Login />
  if (sync === 'sessionExpired') return <Login reason="Сессия закончилась. Войди снова — данные на устройстве сохранились." />

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
          <SyncIndicator />
          <div className={css.footRow}>
            <ThemeSwitch />
            <div className={css.footActions}>
              <Link to="/security" className={css.signOut} title="Ключи и входы" aria-label="Ключи и входы">
                <ShieldCheck size={18} aria-hidden />
              </Link>
              <button type="button" className={css.signOut} onClick={() => void signOut()} title="Выйти: завершить сессию и стереть данные с этого устройства" aria-label="Выйти">
                <SignOut size={18} aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className={css.main}>
        <Link to="/security" className={css.mobileSecurity} aria-label="Ключи и входы">
          <ShieldCheck size={22} aria-hidden />
        </Link>
        <SecurityBanner />
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
