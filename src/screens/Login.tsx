import { useEffect, useState } from 'react'
import { Fingerprint, GithubLogo } from '@phosphor-icons/react'
import { Visor } from '../components/Visor'
import { useSession } from '../app/session'
import { GITHUB_LOGIN_URL } from '../lib/api'
import { passkeySignInErrorText, passkeysSupported, signInWithPasskey } from '../lib/passkey'
import css from './Login.module.css'

/** Коды ошибок, с которыми сервер возвращает с github.com (worker/authGithub.ts). */
const AUTH_ERRORS: Record<string, string> = {
  not_owner: 'Этот аккаунт GitHub — не владелец хаба. Войди своим аккаунтом.',
  expired: 'Вход занял слишком долго или начат в другой вкладке. Попробуй ещё раз.',
  cancelled: 'Вход через GitHub отменён.',
  github: 'GitHub не ответил как надо. Попробуй ещё раз.',
}

/** Ошибка входа через GitHub из адреса (?auth_error=…); адрес сразу чистим, чтобы она не всплывала снова. */
function takeAuthError(): string | null {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('auth_error')
  if (!code) return null
  window.history.replaceState(null, '', window.location.pathname + window.location.hash)
  return AUTH_ERRORS[code] ?? AUTH_ERRORS.github!
}

export function Login({ reason }: { reason?: string }) {
  const signedIn = useSession((s) => s.signedIn)
  const [busy, setBusy] = useState<'passkey' | 'github' | null>(null)
  const [error, setError] = useState<string | null>(reason ?? null)
  const canPasskey = passkeysSupported()

  useEffect(() => {
    const e = takeAuthError()
    if (e) setError(e)
  }, [])

  async function passkey() {
    if (busy) return
    setBusy('passkey')
    setError(null)
    try {
      await signInWithPasskey()
      await signedIn()
    } catch (e) {
      setError(passkeySignInErrorText(e))
    } finally {
      setBusy(null)
    }
  }

  function github() {
    setBusy('github')
    window.location.assign(GITHUB_LOGIN_URL)
  }

  return (
    <main className={css.page}>
      <div className={css.card}>
        <div className={css.head}>
          <Visor size={64} />
          <div>
            <div className="label">Tartaluga · hub</div>
            <h1 className={css.title}>Вход</h1>
          </div>
        </div>

        {/* Решение владельца: на странице входа только кнопки, без пояснений про GitHub и репозиторий. */}
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}

        {canPasskey && (
          <button type="button" className={css.submit} onClick={() => void passkey()} disabled={busy !== null}>
            <Fingerprint size={22} aria-hidden />
            {busy === 'passkey' ? 'Жду подтверждения…' : 'Войти по ключу'}
          </button>
        )}
        <button type="button" className={canPasskey ? css.secondary : css.submit} onClick={github} disabled={busy !== null}>
          <GithubLogo size={20} aria-hidden />
          {busy === 'github' ? 'Перехожу на GitHub…' : 'Войти через GitHub'}
        </button>
      </div>
    </main>
  )
}
