// Окно «Новый проект». Черновик (slug, время, текст файла) собирается при первой попытке и переиспользуется
// при повторе с теми же полями — так повтор после обрыва связи не создаст второй проект.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { X } from '@phosphor-icons/react'
import { errorText, useSession } from '../app/session'
import { STATUS_LABEL, type Status } from '../data/projects'
import { NEW_PROJECT_DRAFT, newProjectDraft, NEXT_STEP_MAX, takenSlugs, TITLE_MAX, type NewProjectInput } from '../data/newProject'
import { uniqueSlug } from '../data/model'
import { ApiError } from '../lib/api'
import { discardRestoredDraft, restoredDraft, useDraft } from '../lib/drafts'
import css from './NewProjectDialog.module.css'

const NEW_STATUSES: Status[] = ['idea', 'active', 'paused']

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const navigate = useNavigate()
  const files = useSession((s) => s.files)
  const tree = useSession((s) => s.tree)
  const createFile = useSession((s) => s.createFile)
  const [input, setInput] = useState<NewProjectInput>({ title: '', status: 'active', nextStep: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Незаконченная форма переживает обновление хаба (ADR-011).
  useDraft(NEW_PROJECT_DRAFT.title, open && input.title ? input.title : undefined, 'Новый проект: название')
  useDraft(NEW_PROJECT_DRAFT.nextStep, open && input.nextStep ? input.nextStep : undefined, 'Новый проект: следующий шаг')
  // Черновик прошлой неудачной попытки: ключ — поля формы, из которых он собран.
  const draft = useRef<{ key: string; slug: string; path: string; text: string } | null>(null)

  const taken = useMemo(() => takenSlugs(tree?.paths ?? files.map((f) => f.path)), [tree, files])
  const preview = input.title.trim() ? uniqueSlug(input.title, taken) : '…'

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setInput({ title: restoredDraft(NEW_PROJECT_DRAFT.title) ?? '', status: 'active', nextStep: restoredDraft(NEW_PROJECT_DRAFT.nextStep) ?? '' })
      discardRestoredDraft(NEW_PROJECT_DRAFT.title)
      discardRestoredDraft(NEW_PROJECT_DRAFT.nextStep)
      setError(null)
      draft.current = null
      d.showModal()
    } else if (!open && d.open) d.close()
  }, [open])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const key = JSON.stringify(input)
    if (draft.current?.key !== key) {
      const d = newProjectDraft(input, taken)
      if (!d.ok) return setError(d.error)
      draft.current = { key, ...d }
    }
    const d = draft.current!
    setBusy(true)
    setError(null)
    try {
      await createFile(d.path, d.text)
      draft.current = null
      onClose()
      navigate(`/projects/${d.slug}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Файл с этим slug появился в репо (с другого устройства или от скилла): новый slug — новый черновик.
        draft.current = null
        void useSession.getState().refresh()
        setError(`Проект «${d.slug}» уже есть в репо. Проверь список проектов или измени название.`)
      } else {
        setError(err instanceof ApiError && err.status === 0 ? 'Нет связи с сервером хаба — проект не создан. Попробуй, когда появится сеть.' : errorText(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className={css.dialog} onClose={onClose} aria-labelledby="new-project-title">
      <form className={css.form} onSubmit={submit}>
        <div className={css.head}>
          <h2 id="new-project-title" className={css.title}>
            Новый проект
          </h2>
          <button type="button" className={css.close} onClick={onClose} aria-label="Закрыть">
            <X size={18} aria-hidden />
          </button>
        </div>

        <label className={css.field}>
          <span className={css.label}>Название</span>
          <input
            value={input.title}
            onChange={(e) => setInput({ ...input, title: e.target.value })}
            maxLength={TITLE_MAX}
            required
            autoFocus
            placeholder="Например, Бот расписания"
          />
        </label>
        <div className={css.slug}>
          файл <span className="mono">projects/{preview}.json</span> — адрес проекта, после создания не меняется
        </div>

        <div className={css.field} role="group" aria-label="Статус">
          <span className={css.label}>Статус</span>
          <div className={css.segment}>
            {NEW_STATUSES.map((s) => (
              <button key={s} type="button" aria-pressed={input.status === s} data-status={s} onClick={() => setInput({ ...input, status: s })}>
                <span className={css.dot} aria-hidden />
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        <label className={css.field}>
          <span className={css.label}>Следующий шаг</span>
          <input
            value={input.nextStep}
            onChange={(e) => setInput({ ...input, nextStep: e.target.value })}
            maxLength={NEXT_STEP_MAX}
            placeholder="Одной строкой, можно оставить пустым"
          />
        </label>

        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}

        <div className={css.actions}>
          <button type="button" className={css.ghost} onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className={css.primary} disabled={busy || !input.title.trim()}>
            {busy ? 'Создаю…' : 'Создать'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
