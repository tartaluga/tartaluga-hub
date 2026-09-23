import { useEffect, useMemo } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { ChartBar, GitBranch, Lightbulb, ShieldCheck, SignOut, SquaresFour, SunHorizon } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { Visor } from '../components/Visor'
import { ThemeSwitch } from '../components/ThemeSwitch'
import { SyncIndicator } from '../components/SyncIndicator'
import { SecurityBanner } from '../components/SecurityBanner'
import { BranchBanner } from '../components/BranchBanner'
import { Login } from '../screens/Login'
import { MAIN, useSession } from './session'
import { buildLibrary } from '../data/projects'
import css from './Shell.module.css'

type Counts = { projects: number; ideas: number }

const NAV: { to: string; label: string; icon: Icon; count?: keyof Counts }[] = [
  { to: '/', label: 'Сегодня', icon: SunHorizon },
  { to: '/projects', label: 'Проекты', icon: SquaresFour, count: 'projects' },
  { to: '/ideas', label: 'Идеи', icon: Lightbulb, count: 'ideas' },
  { to: '/stats', label: 'Статистика', icon: ChartBar },
]

export function Shell() {
  const phase = useSession((s) => s.phase)
  const sync = useSession((s) => s.sync)
  const boot = useSession((s) => s.boot)
  const signOut = useSession((s) => s.signOut)
  const branch = useSession((s) => s.branch)
  const files = useSession((s) => s.files)
  // Счётчики в боковой панели, как в макете: проекты без архива и идеи.
  const counts = useMemo<Counts>(
    () => ({
      projects: buildLibrary(files, new Date()).projects.filter((p) => p.data.status !== 'archived').length,
      ideas: files.filter((f) => f.path.startsWith('ideas/')).length,
    }),
    [files],
  )

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
          {NAV.map(({ to, label, icon: IconCmp, count }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? `${css.link} ${css.active}` : css.link)}>
              <IconCmp size={20} aria-hidden />
              <span>{label}</span>
              {count && counts[count] > 0 && <span className={css.navCount}>{counts[count]}</span>}
              <span className={css.navDot} aria-hidden />
            </NavLink>
          ))}
        </nav>
        <div className={css.sideFoot}>
          <NavLink to="/branches" className={({ isActive }) => (isActive ? `${css.branch} ${css.active}` : css.branch)} title="Ветки репо данных">
            <GitBranch size={18} aria-hidden />
            <span className="mono">{branch}</span>
          </NavLink>
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
        <div className={css.mobileTop}>
          <Link to="/branches" className={css.mobileIcon} data-draft={branch !== MAIN || undefined} aria-label={`Ветки, открыта ${branch}`}>
            <GitBranch size={22} aria-hidden />
          </Link>
          <Link to="/security" className={css.mobileIcon} aria-label="Ключи и входы">
            <ShieldCheck size={22} aria-hidden />
          </Link>
        </div>
        <BranchBanner />
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
