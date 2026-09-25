import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { registerSW } from 'virtual:pwa-register'
import { router } from './app/router'
import { UpdateNotice } from './components/UpdateNotice'
import { idbStateStore, restoreHandoff, saveHandoff } from './lib/drafts'
import { BUILD_ID, installUpdater } from './lib/update'
import './styles/global.css'

// Тема до первого кадра, чтобы не мигала светлая (inline-скрипты запрещены CSP).
try {
  const t = localStorage.getItem('tartaluga.theme')
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t)
} catch {
  /* нет доступа к хранилищу — тема по системе */
}

const store = idbStateStore()

/** Вернуть прокрутку, когда экран дорисуется (данные грузятся асинхронно). Сдаёмся через 2 с. */
function restoreScroll(y: number) {
  if (y <= 0) return
  let tries = 0
  const step = () => {
    if (document.documentElement.scrollHeight >= y + window.innerHeight || ++tries > 20) window.scrollTo(0, y)
    else setTimeout(step, 100)
  }
  requestAnimationFrame(step)
}

async function boot() {
  // Обновление хаба (ADR-011): без плашки, незаконченное переезжает через handoff.
  // Прежний handoff сначала читаем, потом пишем новый — иначе ранний сигнал SW затёр бы непрочитанные черновики.
  let restoreDone!: () => void
  const restoring = new Promise<void>((resolve) => (restoreDone = resolve))
  const { applyWaitingAtStartup } = installUpdater(registerSW, async () => {
    await restoring
    await saveHandoff(store, { route: location.hash, scrollY: window.scrollY, now: Date.now(), build: BUILD_ID })
  })
  // Новая версия уже скачана — включаем её до первого экрана.
  if (await applyWaitingAtStartup()) return

  let restored: Awaited<ReturnType<typeof restoreHandoff>> = { drafts: [], failed: false }
  try {
    restored = await restoreHandoff(store, Date.now())
  } catch (e) {
    console.warn('handoff не прочитан:', e instanceof Error ? e.message : e)
  }
  restoreDone()
  if (restored.route && restored.route !== location.hash.slice(1)) await router.navigate(restored.route, { replace: true })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={router} />
      <UpdateNotice />
    </StrictMode>,
  )
  if (restored.ui) restoreScroll(restored.ui.scrollY)
}

void boot()
