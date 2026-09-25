// «Сделать проектом»: название (из первой строки идеи) и статус. Проект создаётся и идея удаляется одним коммитом;
// проект помнит текст идеи (fromIdea). Черновик переиспользуется при повторе с теми же полями.
import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { ideaErrorText, makeProjectFromIdea, projectFromIdeaDraft, slugPreview, titleFromIdea } from '../data/ideas'
import { STATUS_LABEL, type Status } from '../data/projects'
import { TITLE_MAX } from '../data/newProject'
import { ApiError } from '../lib/api'
import type { Idea } from '../schema/types'
import css from './IdeaRow.module.css'

const NEW_STATUSES: Status[] = ['idea', 'active', 'paused']

export function IdeaToProject({ idea, taken, onCancel }: { idea: Idea; taken: string[]; onCancel(): void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(() => titleFromIdea(idea.text))
  const [status, setStatus] = useState<Status>('active')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = useRef<{ key: string; slug: string; path: string; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const key = JSON.stringify([title, status])
    if (draft.current?.key !== key) {
      const d = projectFromIdeaDraft(idea, { title, status, nextStep: '' }, taken)
      if (!d.ok) return setError(d.error)
      draft.current = { key, ...d }
    }
    const d = draft.current
    setBusy(true)
    setError(null)
    try {
      await makeProjectFromIdea(idea.id, d)
      navigate(`/projects/${d.slug}`)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slug_taken') draft.current = null
      setError(err instanceof ApiError && err.status !== 0 ? err.message : ideaErrorText(err, 'проект не создан'))
      setBusy(false)
    }
  }

  return (
    <form className={css.toProject} onSubmit={submit} aria-label="Сделать проектом">
      <label className={css.field}>
        <span className={css.label}>Название проекта</span>
        <input className={css.input} value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} required />
        <span className={css.hint}>
          файл projects/<span className="mono">{slugPreview(title, taken)}</span>.json · текст идеи сохранится в проекте
        </span>
      </label>
      <label className={css.field}>
        <span className={css.label}>Статус</span>
        <select className={css.input} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {NEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      <div className={css.actions}>
        <button type="submit" className={css.primary} disabled={busy}>
          {busy ? 'Создаю…' : 'Создать проект'}
        </button>
        <button type="button" className={css.ghost} onClick={onCancel} disabled={busy}>
          Отмена
        </button>
      </div>
    </form>
  )
}
