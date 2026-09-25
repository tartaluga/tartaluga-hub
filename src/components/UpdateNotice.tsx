import { useState, useSyncExternalStore } from 'react'
import { dismissRescue, idbStateStore, useRescue } from '../lib/drafts'
import { getUpdateStatus, subscribeUpdateStatus, type UpdateStatus } from '../lib/update'
import css from './UpdateNotice.module.css'

// Плашки «Обновить» больше нет (ADR-011): хаб обновляется сам. Здесь — только два случая, когда нужен владелец:
// обновление отложено защитой от петли и черновик не удалось перенести в новую версию.

export function UpdateNoticeView({ status, rescue, onCopy, onDismiss, copied }: {
  status: UpdateStatus
  rescue: string | null
  onCopy: () => void
  onDismiss: () => void
  copied: boolean
}) {
  return (
    <>
      {status === 'deferred' && (
        <div className={css.banner} role="status">
          <span>Хаб обновляется, правки сохранены на устройстве</span>
        </div>
      )}
      {rescue !== null && (
        <section className={css.rescue} role="alertdialog" aria-labelledby="rescue-title">
          <h2 id="rescue-title" className={css.title}>
            Не удалось перенести черновик
          </h2>
          <p className={css.hint}>Новая версия хаба не смогла прочитать незаконченную правку. Скопируй текст и вставь заново.</p>
          <textarea className={css.text} readOnly value={rescue} aria-label="Текст черновика" />
          <div className={css.actions}>
            <button type="button" className={css.primary} onClick={onCopy}>
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button type="button" className={css.ghost} onClick={onDismiss}>
              Убрать
            </button>
          </div>
        </section>
      )}
    </>
  )
}

export function UpdateNotice() {
  const status = useSyncExternalStore(subscribeUpdateStatus, getUpdateStatus, getUpdateStatus)
  const rescue = useRescue()
  const [copied, setCopied] = useState(false)
  return (
    <UpdateNoticeView
      status={status}
      rescue={rescue}
      copied={copied}
      onCopy={() => {
        if (rescue === null) return
        navigator.clipboard?.writeText(rescue).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
      onDismiss={() => void dismissRescue(idbStateStore())}
    />
  )
}
