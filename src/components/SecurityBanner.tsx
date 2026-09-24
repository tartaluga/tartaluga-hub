// Плашки над экраном: новые события безопасности и предложение войти по ключу после входа через GitHub (ADR-007).
import { useState } from 'react'
import { Link } from 'react-router'
import { Fingerprint, ShieldWarning, X } from '@phosphor-icons/react'
import { useSession } from '../app/session'
import { addPasskey, passkeyErrorText, passkeysSupported } from '../lib/passkey'
import css from './SecurityBanner.module.css'

const OFFER_KEY = 'tartaluga.passkeyOffer.dismissed'

/** 1 важное событие, 2 важных события, 5 важных событий, 21 важное событие. */
export function eventsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'важное событие'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'важных события'
  return 'важных событий'
}

function offerDismissed(): boolean {
  try {
    return localStorage.getItem(OFFER_KEY) === '1'
  } catch {
    return false
  }
}

export function SecurityBanner() {
  const me = useSession((s) => s.me)
  const [hideOffer, setHideOffer] = useState(offerDismissed)
  const [state, setState] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null })

  const dismiss = () => {
    try {
      localStorage.setItem(OFFER_KEY, '1')
    } catch {
      /* не сохранится — покажем ещё раз, не страшно */
    }
    setHideOffer(true)
  }

  async function add() {
    setState({ busy: true, text: null })
    try {
      await addPasskey()
      setState({ busy: false, text: 'Ключ добавлен. В следующий раз входи по нему.' })
      dismiss()
    } catch (e) {
      setState({ busy: false, text: passkeyErrorText(e) })
    }
  }

  if (!me) return null
  const unseen = me.unseenSecurityEvents
  const offer = !hideOffer && me.session.authMethod === 'github' && passkeysSupported()

  return (
    <>
      {unseen > 0 && (
        <div className={css.banner} data-tone="warn" role="status">
          <ShieldWarning size={20} aria-hidden />
          <span>Пока тебя не было: {unseen} {eventsWord(unseen)} — входы, изменения ключей.</span>
          <Link to="/settings/security" className={css.action}>
            Посмотреть
          </Link>
        </div>
      )}
      {offer && (
        <div className={css.banner} role="status">
          <Fingerprint size={20} aria-hidden />
          <span>Входи по отпечатку или Windows Hello: добавь ключ этого устройства.</span>
          <button type="button" className={css.action} onClick={() => void add()} disabled={state.busy}>
            {state.busy ? 'Жду…' : 'Добавить'}
          </button>
          <button type="button" className={css.close} onClick={dismiss} aria-label="Не сейчас">
            <X size={16} aria-hidden />
          </button>
        </div>
      )}
      {state.text && (
        <div className={css.banner} role="status">
          <span>{state.text}</span>
          {!offer && (
            <button type="button" className={css.close} onClick={() => setState({ busy: false, text: null })} aria-label="Закрыть">
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
      )}
    </>
  )
}
