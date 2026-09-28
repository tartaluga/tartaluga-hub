// Диалог стража выхода: неотправленные правки и конфликты сотрутся. Выход только по «Стереть и выйти».
import { useEffect, useRef, useState } from 'react'
import { DownloadSimple, SignOut, WarningCircle } from '@phosphor-icons/react'
import { answerSignOut, downloadUnsent, unsentMessage, useSignOutGuard, type SignOutAsk } from '../app/signOutGuard'
import css from './SignOutGuardDialog.module.css'

/** Другая вкладка хаба держит свою очередь в памяти — выход сотрёт устройство и под ней. */
export const OTHER_TABS = 'Если хаб открыт в другой вкладке, закрой её сначала — её неотправленные правки тоже сотрутся.'

const TITLE = { device: 'Выйти с этого устройства?', everywhere: 'Выйти на всех устройствах?' } as const

/** Страж выхода: диалог есть в DOM, только пока открыт вопрос (иначе он мешал бы другим модальным окнам и тестам). */
export function SignOutGuardDialog() {
  const ask = useSignOutGuard((s) => s.ask)
  return ask ? <GuardDialog key={ask.id} ask={ask} /> : null
}

function GuardDialog({ ask }: { ask: SignOutAsk }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => {
      if (d?.open) d.close()
    }
  }, [])

  const download = async () => {
    try {
      await downloadUnsent()
      setSaved(true)
      setError(null)
    } catch (e) {
      setError(`Не удалось скачать: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <dialog
      ref={ref}
      className={css.dialog}
      aria-labelledby="signout-guard-title"
      aria-describedby="signout-guard-text"
      // Esc — это «Отмена»: выходить без явного согласия нельзя.
      onCancel={(e) => {
        e.preventDefault()
        answerSignOut(false)
      }}
    >
      <div className={css.body}>
        <h2 id="signout-guard-title" className={css.title}>
          <WarningCircle size={22} aria-hidden /> {TITLE[ask.scope]}
        </h2>
        <div id="signout-guard-text" className={css.text}>
          <p>
            {unsentMessage(ask.counts)} Скачай их файлом, чтобы не потерять: там твои версии всех спорных мест.
            {ask.scope === 'everywhere' && ' Входы на других устройствах тоже завершатся.'}
          </p>
          <p>{OTHER_TABS}</p>
        </div>
        {saved && (
          <p className={css.saved} role="status">
            Файл скачан. Проверь, что он сохранился, прежде чем стирать.
          </p>
        )}
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
        <div className={css.actions}>
          <button type="button" className={css.primary} onClick={() => void download()}>
            <DownloadSimple size={18} aria-hidden /> Скачать неотправленное
          </button>
          <button type="button" className={css.danger} onClick={() => answerSignOut(true)}>
            <SignOut size={18} aria-hidden /> Стереть и выйти
          </button>
          <button type="button" className={css.ghost} onClick={() => answerSignOut(false)}>
            Отмена
          </button>
        </div>
      </div>
    </dialog>
  )
}
