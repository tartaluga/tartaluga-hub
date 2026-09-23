import { useState, type FormEvent } from 'react'
import { ArrowSquareOut, Eye, EyeSlash } from '@phosphor-icons/react'
import { Visor } from '../components/Visor'
import { useSession } from '../app/session'
import { TOKEN_HELP_URL } from '../config'
import css from './Login.module.css'

const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)

export function Login({ reason }: { reason?: string }) {
  const signIn = useSession((s) => s.signIn)
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(reason ?? null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const err = await signIn(token)
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <main className={css.page}>
      <form className={css.card} onSubmit={submit}>
        <div className={css.head}>
          <Visor size={64} />
          <div>
            <div className="label">Tartaluga · hub</div>
            <h1 className={css.title}>Вход</h1>
          </div>
        </div>

        <p className={css.lead}>
          Хаб читает данные из приватного репозитория через твой токен GitHub. Токен сохраняется только на этом устройстве.
        </p>

        <label className="label" htmlFor="token">
          Токен
        </label>
        <div className={css.field}>
          <input
            id="token"
            name="token"
            type={show ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={css.input}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'token-error' : undefined}
          />
          <button type="button" className={css.eye} onClick={() => setShow((v) => !v)} aria-label={show ? 'Скрыть токен' : 'Показать токен'}>
            {show ? <EyeSlash size={20} /> : <Eye size={20} />}
          </button>
        </div>

        {error && (
          <p id="token-error" className={css.error} role="alert">
            {error}
          </p>
        )}

        <button type="submit" className={css.submit} disabled={busy || token.trim() === ''}>
          {busy ? 'Проверяю…' : 'Войти'}
        </button>

        <div className={css.notes}>
          <a href={TOKEN_HELP_URL} target="_blank" rel="noreferrer" className={css.link}>
            Как создать токен <ArrowSquareOut size={14} aria-hidden />
          </a>
          {isIOS && (
            <p className={css.hint}>
              На iPhone установленное приложение хранит данные отдельно от Safari. Если ставишь хаб на экран «Домой», вводи токен уже в нём.
            </p>
          )}
        </div>
      </form>
    </main>
  )
}
