// Плашка вкладки просмотра (ADR-013): хаб открыт в другой вкладке, пишет она. Пока плашка видна, поля ввода
// не принимают текст (lockInputs), а правки отклоняет сессия. «Писать здесь» просит пишущую уступить: она сохраняет
// черновики и отпускает запись. Пишущая закрылась или уступила — плашка уходит сама.
import { useEffect } from 'react'
import { Eye } from '@phosphor-icons/react'
import { READ_ONLY, useSession } from '../app/session'
import { lockInputs } from '../lib/readOnlyInputs'
import css from './ReadOnlyBanner.module.css'

export const TAKEOVER_ASKING = 'Прошу другую вкладку уступить…'
export const TAKEOVER_NO_ANSWER = 'Другая вкладка не ответила — закрой её или нажми ещё раз.'
export const TAKEOVER_REFUSED = 'Другая вкладка не может уступить: её правка не сохранена на устройстве. Закрой её или попробуй позже.'

export function ReadOnlyBanner() {
  const readOnly = useSession((s) => s.readOnly)
  const takeover = useSession((s) => s.takeover)
  const requestWrite = useSession((s) => s.requestWrite)

  useEffect(() => (readOnly ? lockInputs(document) : undefined), [readOnly])

  if (!readOnly) return null
  return (
    <div className={css.banner} role="status">
      <Eye size={20} aria-hidden />
      <span>
        {READ_ONLY}
        {takeover && <span className={css.note}> {takeover === 'asking' ? TAKEOVER_ASKING : takeover === 'refused' ? TAKEOVER_REFUSED : TAKEOVER_NO_ANSWER}</span>}
      </span>
      <button type="button" className={css.take} onClick={() => requestWrite()} disabled={takeover === 'asking'}>
        Писать здесь
      </button>
    </div>
  )
}
