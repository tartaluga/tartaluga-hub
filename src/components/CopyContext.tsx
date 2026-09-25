// Кнопка «Скопировать контекст» в карточке проекта (D5): Markdown-сводка для новой сессии Claude.
// Работает и в режиме только чтения. Если браузер не дал доступ к буферу, текст открывается в диалоге,
// уже выделенным, — скопировать вручную.
import { useEffect, useRef, useState } from 'react'
import { ClipboardText, X } from '@phosphor-icons/react'
import { buildClaudeContext } from '../data/claudeContext'
import type { Project } from '../schema/types'
import css from './CopyContext.module.css'

export function CopyContext({ project }: { project: Project }) {
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    const d = dialog.current
    if (!d || manual === null) return
    if (!d.open) d.showModal?.()
    area.current?.focus()
    area.current?.select()
  }, [manual])

  async function copy() {
    const text = buildClaudeContext(project)
    setCopied(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('нет буфера')
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setManual(text)
    }
  }

  function close() {
    dialog.current?.close?.()
    setManual(null)
  }

  return (
    <div className={css.row}>
      <button type="button" className={css.button} onClick={() => void copy()} title="Markdown-сводка проекта для новой сессии Claude">
        <ClipboardText size={18} aria-hidden /> Скопировать контекст
      </button>
      <span className={css.copied} role="status" aria-live="polite">
        {copied ? 'Скопировано' : ''}
      </span>
      {manual !== null && (
        <dialog ref={dialog} className={css.dialog} onClose={() => setManual(null)} aria-labelledby="copy-context-title">
          <div className={css.body}>
            <div className={css.head}>
              <h2 id="copy-context-title" className={css.title}>
                Контекст для Claude
              </h2>
              <button type="button" className={css.close} onClick={close} aria-label="Закрыть">
                <X size={20} aria-hidden />
              </button>
            </div>
            <p className={css.hint}>Браузер не дал доступ к буферу обмена. Текст уже выделен — скопируй его вручную (Ctrl+C).</p>
            <textarea ref={area} className={css.text} readOnly value={manual} rows={14} aria-label="Текст контекста" />
          </div>
        </dialog>
      )}
    </div>
  )
}
