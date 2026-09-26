import { useEffect, useMemo, useRef } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { ChartBar, GearSix, GitMerge, Lightbulb, SignOut, SquaresFour, SunHorizon } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { Visor } from '../components/Visor'
import { ThemeSwitch } from '../components/ThemeSwitch'
import { SyncIndicator } from '../components/SyncIndicator'
import { SecurityBanner } from '../components/SecurityBanner'
import { BranchBanner } from '../components/BranchBanner'
import { Login } from '../screens/Login'
import { installSyncTriggers, useSession } from './session'
import { conflictCount } from '../screens/Conflicts'
import { plural } from '../lib/plural'
import { buildLibrary } from '../data/projects'
import { persistDrafts } from '../lib/drafts'
import css from './Shell.module.css'

type Counts = { projects: number; ideas: number; conflicts: number }

type NavItem = { to: string; label: string; icon: Icon; count?: keyof Counts; hot?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Сегодня', icon: SunHorizon },
  { to: '/projects', label: 'Проекты', icon: SquaresFour, count: 'projects' },
  { to: '/ideas', label: 'Идеи', icon: Lightbulb, count: 'ideas' },
  { to: '/stats', label: 'Статистика', icon: ChartBar },
]

/** «Входящие конфликты» — пункт появляется, только когда есть что разбирать (ADR-004), счётчик маджентой. */
const CONFLICTS_NAV: NavItem = { to: '/conflicts', label: 'Конфликты', icon: GitMerge, count: 'conflicts', hot: true }

/** Экраны телефона, в шапке которых шестерёнка настроек (макет: «Сегодня» и «Проекты»). */
const GEAR_SCREENS = ['/', '/projects']

const EXPIRED = 'Сессия закончилась. Войди снова — данные на устройстве сохранились.'

/**
 * Вход заново поверх открытого экрана: экран не размонтируется, открытые поля и их текст остаются.
 * Модальный dialog — поверх любых других диалогов (верхний слой), остальное недоступно, Esc не закрывает.
 */
function ReLogin({ queued }: { queued: number }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => {
      if (d?.open) d.close()
    }
  }, [])
  return (
    <dialog ref={ref} className={css.relogin} onCancel={(e) => e.preventDefault()} aria-label="Вход">
      <Login reason={EXPIRED + (queued > 0 ? ` ${queued} ${plural(queued, 'правка ждёт', 'правки ждут', 'правок ждут')} отправки и уйдут после входа.` : '')} />
    </dialog>
  )
}

export function Shell() {
  const { pathname } = useLocation()
  const phase = useSession((s) => s.phase)
  const sync = useSession((s) => s.sync)
  const boot = useSession((s) => s.boot)
  const signOut = useSession((s) => s.signOut)
  const files = useSession((s) => s.files)
  const conflicts = useSession((s) => s.conflicts)
  const queued = useSession((s) => s.queued)
  // Счётчики в боковой панели, как в макете: проекты без архива и идеи.
  const counts = useMemo<Counts>(
    () => ({
      projects: buildLibrary(files, new Date()).projects.filter((p) => p.data.status !== 'archived').length,
      ideas: files.filter((f) => f.path.startsWith('ideas/')).length,
      conflicts: conflictCount(conflicts),
    }),
    [files, conflicts],
  )
  const nav = counts.conflicts > 0 ? [...NAV, CONFLICTS_NAV] : NAV

  // ADR-007: «Выйти» предупреждает о неотправленных правках — они сотрутся вместе с данными устройства.
  const confirmSignOut = () => {
    if (queued > 0 && !window.confirm(`${queued} ${plural(queued, 'правка ещё не отправлена', 'правки ещё не отправлены', 'правок ещё не отправлены')}. Выйти и стереть их с этого устройства?`)) return
    void signOut()
  }

  useEffect(() => {
    void boot()
  }, [boot])

  // Вернулись в приложение или появилась сеть — сверка и отправка очереди правок (ADR-004).
  useEffect(() => installSyncTriggers(), [])

  // Сессия кончилась: на случай ухода со страницы (вход через GitHub, закрытие) черновики сразу в handoff.
  const expired = sync === 'sessionExpired'
  useEffect(() => {
    if (expired) persistDrafts().catch((e: unknown) => console.warn('черновики не записаны:', e instanceof Error ? e.message : e))
  }, [expired])

  if (phase === 'booting') return <div className={css.boot} aria-hidden><Visor size={72} /></div>
  if (phase === 'signedOut') return <Login />

  return (
    <div className={css.shell}>
      {expired && <ReLogin queued={queued} />}
      <aside className={css.side}>
        <div className={css.brand}>
          <Visor />
          <div>
            <div className={css.brandName}>Tartaluga</div>
            <div className={css.brandSub}>HUB</div>
          </div>
        </div>
        <nav className={css.nav} aria-label="Разделы">
          {nav.map(({ to, label, icon: IconCmp, count, hot }) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? `${css.link} ${css.active}` : css.link)}>
              <IconCmp size={20} aria-hidden />
              <span>{label}</span>
              {count && counts[count] > 0 && <span className={hot ? `${css.navCount} ${css.navHot}` : css.navCount}>{counts[count]}</span>}
              <span className={css.navDot} aria-hidden />
            </NavLink>
          ))}
        </nav>
        <div className={css.sideFoot}>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? `${css.link} ${css.active}` : css.link)}>
            <GearSix size={20} aria-hidden />
            <span>Настройки</span>
            <span className={css.navDot} aria-hidden />
          </NavLink>
          <SyncIndicator />
          <div className={css.footRow}>
            <ThemeSwitch />
            <button type="button" className={css.signOut} onClick={confirmSignOut} title="Выйти: завершить сессию и стереть данные с этого устройства" aria-label="Выйти">
              <SignOut size={18} aria-hidden />
            </button>
          </div>
        </div>
      </aside>

      <main className={css.main}>
        {GEAR_SCREENS.includes(pathname) && (
          <div className={css.mobileTop}>
            <Link to="/settings" className={css.mobileIcon} aria-label="Настройки">
              <GearSix size={22} aria-hidden />
            </Link>
          </div>
        )}
        <BranchBanner />
        <SecurityBanner />
        <Outlet />
      </main>

      <nav className={css.bottom} aria-label="Разделы">
        {nav.map(({ to, label, icon: IconCmp, count, hot }) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? `${css.tab} ${css.active}` : css.tab)}>
            <IconCmp size={22} aria-hidden />
            <span>{label}</span>
            {hot && count && <span className={css.tabHot}>{counts[count]}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
