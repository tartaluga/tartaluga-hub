// Строка идеи: дата, первая строка текста, справа — проект или «В проект».
// Раскрытая строка: правка текста на месте, привязка к проекту, «Сделать проектом», удаление.
import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowBendUpRight, LockSimple } from '@phosphor-icons/react'
import { deleteIdea, IDEA_MAX, ideaErrorText, saveIdea, shortDate, type IdeaView, type ProjectRef } from '../data/ideas'
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

  function remove() {
    if (!window.confirm(`Удалить идею «${idea.title}»? Файл удалится из репо данных.`)) return
    void run('идея не удалена', () => deleteIdea(idea.id))
  }

  // Проект, к которому привязана идея, может быть удалён мимо хаба — тогда он всё равно в списке, чтобы select не врал.
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
              <p className={css.text}>{idea.data.text}</p>
              <p className={css.note}>{idea.reason}</p>
            </>
          ) : (
            <>
              <InlineText
                className={css.text}
                value={idea.data.text}
                placeholder="Текст идеи"
                label="Текст идеи"
                maxLength={IDEA_MAX}
                multiline
                onSave={saveText}
              />
              {making ? (
                <IdeaToProject idea={idea.data} taken={taken} onCancel={() => setMaking(false)} />
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
                  <button type="button" className={css.primary} disabled={busy} onClick={() => setMaking(true)}>
                    Сделать проектом
                  </button>
                  <button type="button" className={css.danger} disabled={busy} onClick={remove}>
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
