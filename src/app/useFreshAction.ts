// Действия, которым сервер может ответить fresh_login_required (ADR-007): удаление ключа и ветки, «Выйти везде».
// Если на аккаунте есть ключи — подтверждаем вход ключом и повторяем действие; если нет — просим подтвердить через GitHub.
import { useState } from 'react'
import { ApiError, listPasskeys } from '../lib/api'
import { passkeyErrorText, passkeysSupported, signInWithPasskey } from '../lib/passkey'
import { useSession } from './session'

export function useFreshAction() {
  const signedIn = useSession((s) => s.signedIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needGithub, setNeedGithub] = useState(false)

  /** Выполнить действие. Возвращает true, если оно прошло. */
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
    setNeedGithub(false)
    try {
      try {
        await action()
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'fresh_login_required')) throw e
        const { passkeys } = await listPasskeys()
        if (!passkeys.length || !passkeysSupported()) {
          setNeedGithub(true)
          return false
        }
        await signInWithPasskey()
        await signedIn()
        await action()
      }
      return true
    } catch (e) {
      const text = passkeyErrorText(e)
      if (text) setError(text)
      return false
    } finally {
      setBusy(false)
    }
  }

  return { run, busy, error, setError, needGithub }
}
