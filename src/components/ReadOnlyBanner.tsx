// Плашка вкладки просмотра (ADR-013): хаб открыт в другой вкладке, пишет она. Пока плашка видна, поля ввода
// не принимают текст (lockInputs), а правки отклоняет сессия. Прежняя вкладка закрылась — плашка уходит сама.
import { useEffect } from 'react'
import { Eye } from '@phosphor-icons/react'
import { READ_ONLY, useSession } from '../app/session'
import { lockInputs } from '../lib/readOnlyInputs'
import css from './ReadOnlyBanner.module.css'

export function ReadOnlyBanner() {
  const readOnly = useSession((s) => s.readOnly)

  useEffect(() => (readOnly ? lockInputs(document) : undefined), [readOnly])

  if (!readOnly) return null
  return (
    <div className={css.banner} role="status">
      <Eye size={20} aria-hidden />
      <span>{READ_ONLY}</span>
    </div>
  )
}
