import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './app/router'
import { UpdateBanner } from './components/UpdateBanner'
import './styles/global.css'

// Тема до первого кадра, чтобы не мигала светлая (inline-скрипты запрещены CSP).
try {
  const t = localStorage.getItem('tartaluga.theme')
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t)
} catch {
  /* нет доступа к хранилищу — тема по системе */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <UpdateBanner />
  </StrictMode>,
)
