// Строка идеи: дата, первая строка текста, справа — проект или «В проект».
// Раскрытая строка: полный текст (если он длиннее первой строки) с правкой на месте, привязка к проекту,
// «Сделать проектом» (только для идеи без проекта), удаление.
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowBendUpRight, LockSimple } from '@phosphor-icons/react'
import { deleteIdea, IDEA_MAX, ideaErrorText, saveIdea, shortDate, textExtendsTitle, type IdeaView, type ProjectRef } from '../data/ideas'
import { InlineText } from './InlineText'
import { IdeaToProject } from './IdeaToProject'
import css from './IdeaRow.module.css'

interface Props {
  idea: IdeaView
  projects: ProjectRef[]
  /** Занятые slug проектов — для черновика «Сделать проектом». */
  taken: string[]
  open: boolean
  onToggle(open: boolean): void
}

const NO_PROJECT = ''

export function IdeaRow({ idea, projects, taken, open, onToggle }: Props) {
  const [making, setMaking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const removeButton = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelId = `idea-${idea.id}`

  async function run(what: string, action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(ideaErrorText(e, what))
    } finally {
      setBusy(false)
    }
  }

  async function saveText(text: string): Promise<string | null> {
    try {
      await saveIdea(idea.id, { text })
      return null
    } catch (e) {
      return ideaErrorText(e, 'правка не сохранена')
    }
  }

  /** Удаление — после подтверждения внутри страницы (как у тегов). */
  function remove() {
    setConfirming(false)
    void run('идея не удалена', () => deleteIdea(idea.id))
  }

  function cancelRemove() {
    setConfirming(false)
    // Кнопка «Удалить» снова в DOM только после отрисовки — возвращаем фокус на неё.
    requestAnimationFrame(() => removeButton.current?.focus())
  }

  // Проект, к которому привязана идея, может быть удалён мимо хаба — тогда он всё равно в списке, чтобы select не врал.
  const hasMore = textExtendsTitle(idea.data.text)
  const options = idea.project && !idea.projectTitle ? [{ slug: idea.project, title: `${idea.project} (проект удалён)` }, ...projects] : projects

  return (
    <li className={css.row} data-open={open || undefined}>
      <div className={css.line}>
        <time className={css.date} dateTime={idea.data.createdAt}>
          {shortDate(idea.data.createdAt)}
        </time>
        <button type="button" className={css.title} aria-expanded={open} aria-controls={panelId} onClick={() => onToggle(!open)}>
          {idea.title}
          {idea.readOnly && <LockSimple size={14} className={css.lock} aria-label="только чтение" />}
        </button>
        <span className={css.side}>
          {idea.project ? (
            idea.projectTitle ? (
              <Link className={css.chip} to={`/projects/${idea.project}`}>
                {idea.projectTitle}
              </Link>
            ) : (
              <span className={css.chipGone} title={`Проекта «${idea.project}» нет в этой ветке`}>
                проект удалён
              </span>
            )
          ) : (
            !idea.readOnly && (
              <button type="button" className={css.toLink} onClick={() => onToggle(true)}>
                <ArrowBendUpRight size={16} aria-hidden /> В проект
              </button>
            )
          )}
        </span>
      </div>

      {open && (
        <div id={panelId} className={css.panel}>
          {idea.readOnly ? (
            <>
              {hasMore && <p className={css.text}>{idea.data.text}</p>}
              <p className={css.note}>{idea.reason}</p>
            </>
          ) : (
            <>
              <InlineText
                className={css.text}
                value={idea.data.text}
                display={hasMore ? undefined : <span className={css.editText}>Изменить текст</span>}
                placeholder="Текст идеи"
                label="Текст идеи"
                maxLength={IDEA_MAX}
                multiline
                onSave={saveText}
              />
              {making ? (
                <IdeaToProject idea={idea.data} taken={taken} onCancel={() => setMaking(false)} />
              ) : confirming ? (
                <DeleteIdeaConfirm title={idea.title} onConfirm={remove} onCancel={cancelRemove} />
              ) : (
                <div className={css.actions}>
                  <label className={css.inline}>
                    <span className={css.label}>Проект</span>
                    <select
                      className={css.input}
                      value={idea.project ?? NO_PROJECT}
                      disabled={busy}
                      onChange={(e) => {
                        const slug = e.target.value
                        void run('привязка не сохранена', () => saveIdea(idea.id, { project: slug === NO_PROJECT ? null : slug }))
                      }}
                    >
                      <option value={NO_PROJECT}>— без проекта —</option>
                      {options.map((p) => (
                        <option key={p.slug} value={p.slug}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* Уже привязанную к проекту идею проектом не делаем: сначала «— без проекта —». */}
                  {!idea.project && (
                    <button type="button" className={css.primary} disabled={busy} onClick={() => setMaking(true)}>
                      Сделать проектом
                    </button>
                  )}
                  <button ref={removeButton} type="button" className={css.danger} disabled={busy} onClick={() => setConfirming(true)}>
                    Удалить
                  </button>
                </div>
              )}
              {error && (
                <p className={css.error} role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** Подтверждение удаления идеи внутри страницы. Escape — отмена. */
export function DeleteIdeaConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm(): void; onCancel(): void }) {
  return (
    <div
      className={css.confirm}
      role="group"
      aria-label={`Удаление идеи «${title}»`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <p className={css.confirmText}>Удалить идею «{title}»? Файл удалится из репо данных, вернуть можно только через историю git.</p>
      <div className={css.confirmActions}>
        <button type="button" className={css.confirmDelete} autoFocus onClick={onConfirm}>
          Удалить идею
        </button>
        <button type="button" className={css.confirmCancel} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}
