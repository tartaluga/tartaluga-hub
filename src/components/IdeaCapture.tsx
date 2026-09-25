// Быстрое добавление идеи: строка ввода, Enter или «Сохранить». Черновик (id и текст файла) собирается
// при первой попытке и переиспользуется при повторе того же текста — повтор после обрыва не создаст дубль.
import { useRef, useState, type FormEvent } from 'react'
import { Lightbulb } from '@phosphor-icons/react'
import { createIdea, IDEA_MAX, ideaErrorText, newIdeaDraft } from '../data/ideas'
import css from './IdeaCapture.module.css'

export function IdeaCapture() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = useRef<{ key: string; path: string; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (draft.current?.key !== text) {
      const d = newIdeaDraft(text)
      if (!d.ok) return setError(d.error)
      draft.current = { key: text, path: d.path, text: d.text }
    }
    setBusy(true)
    setError(null)
    try {
      await createIdea(draft.current)
      draft.current = null
      setText('')
    } catch (err) {
      setError(ideaErrorText(err, 'идея не сохранена'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={css.form} onSubmit={submit}>
      <div className={css.bar}>
        <Lightbulb size={22} className={css.icon} aria-hidden />
        <input
          className={css.input}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          placeholder="Новая идея… Enter — сохранить"
          aria-label="Новая идея"
          maxLength={IDEA_MAX}
          enterKeyHint="done"
          autoComplete="off"
        />
        <button type="submit" className={css.save} disabled={busy || !text.trim()}>
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
