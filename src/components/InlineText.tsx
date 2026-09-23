// Правка текста на месте: нажал — поле ввода; Enter или уход из поля — сохранить, Esc — отменить.
// Если сохранить не вышло, поле остаётся открытым с введённым текстом и причиной — ввод не теряется.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import css from './InlineText.module.css'

interface Props {
  value: string
  /** Что показать вместо значения (например, со стрелкой «→»). */
  display?: ReactNode
  placeholder: string
  label: string
  maxLength: number
  multiline?: boolean
  readOnly?: boolean
  className?: string
  /** Открыть сразу в режиме правки (например, по кнопке «Изменить» рядом). */
  autoOpen?: boolean
  /** Поле закрылось: сохранили, отменили или ничего не поменяли. */
  onClose?(): void
  /** null — сохранено, строка — ошибка для человека. */
  onSave(text: string): Promise<string | null>
}

export function InlineText({ value, display, placeholder, label, maxLength, multiline, readOnly, className, autoOpen, onClose, onSave }: Props) {
  const [editing, setEditing] = useState(!!autoOpen && !readOnly)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) return
    const el = field.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  function open() {
    if (readOnly) return
    setDraft(value)
    setError(null)
    setEditing(true)
  }

  function close() {
    setEditing(false)
    onClose?.()
  }

  async function commit() {
    if (saving.current) return
    if (draft === value) return close()
    saving.current = true
    setBusy(true)
    const err = await onSave(draft)
    saving.current = false
    setBusy(false)
    if (err) {
      setError(err)
      field.current?.focus()
    } else close()
  }

  function cancel() {
    setDraft(value)
    setError(null)
    close()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void commit()
    }
  }

  if (!editing) {
    if (readOnly) return <div className={`${css.view} ${className ?? ''}`}>{value ? (display ?? value) : <span className={css.placeholder}>{placeholder}</span>}</div>
    return (
      <button type="button" className={`${css.view} ${css.editable} ${className ?? ''}`} onClick={open} aria-label={`${label}: ${value || 'не задано'}. Изменить`}>
        {value ? (display ?? value) : <span className={css.placeholder}>{placeholder}</span>}
      </button>
    )
  }

  const common = {
    ref: field,
    value: draft,
    maxLength,
    disabled: busy,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onKeyDown,
    onBlur: () => void commit(),
  }
  return (
    <div className={css.editor}>
      {multiline ? <textarea {...common} className={`${css.field} ${css.area}`} rows={8} /> : <input {...common} className={`${css.field} ${className ?? ''}`} />}
      <div className={css.hint}>
        {busy ? 'Сохраняю…' : multiline ? 'Ctrl+Enter — сохранить, Esc — отменить' : 'Enter — сохранить, Esc — отменить'}
      </div>
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
