// Страница задачи (ADR-016 п. 6): #/projects/<slug>/tasks/<taskId>. Название карандашом, статус из четырёх
// сегментов, срок, веха, описание, ссылки, комментарии, удаление. Правки идут той же очередью, что и в карточке
// проекта (useProjectEditing); смена статуса и срока добавляет запись в лог проекта (taskEdit.ts).
import { lazy, Suspense, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, CaretRight, PaperPlaneRight, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { useProjectEditing, type Save } from '../app/useProjectEditing'
import { InlineText } from '../components/InlineText'
import { DueForm } from '../components/ProjectTasks'
import { COMMENT_MAX, logWhen, TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, taskDue } from '../data/editProject'
import { commentAuthor, isTaskId, newComment, setTaskDue, setTaskStatus, TASK_STATUS_LABEL, TASK_STATUSES, taskStatus } from '../data/taskEdit'
import { nowIso } from '../data/model'
import { restoredDraft, useDraftText } from '../lib/drafts'
import type { Comment, Milestone, Task } from '../schema/types'
import { LinksEditor } from './Project'
import pcss from './Project.module.css'
import css from './TaskPage.module.css'

// Разбор Markdown — отдельный чанк, как в карточке проекта.
const Markdown = lazy(() => import('../components/Markdown').then((m) => ({ default: m.Markdown })))

export function TaskPage() {
  const { slug = '', taskId = '' } = useParams()
  // Свой экземпляр на каждую задачу: открытые поля и неподтверждённые правки не переезжают в другую.
  return <TaskView key={`${slug}/${taskId}`} slug={slug} taskId={taskId} />
}

function TaskView({ slug, taskId }: { slug: string; taskId: string }) {
  const navigate = useNavigate()
  const { d, broken, sync, save, ro } = useProjectEditing(slug)
  const project = `/projects/${slug}`
  const back = (
    <Link to={project} className={css.crumbLink}>
      <ArrowLeft size={16} aria-hidden /> К проекту
    </Link>
  )

  if (!d) {
    return (
      <section className={pcss.page}>
        {back}
        <p className={pcss.muted}>
          {broken ? `Файл проекта не читается: ${broken.error}` : sync === 'syncing' ? 'Загружаю…' : 'Такого проекта нет в этой ветке.'}
        </p>
      </section>
    )
  }

  const task = isTaskId(taskId) ? (d.tasks ?? []).find((t) => t.id === taskId) : undefined
  if (!task) {
    return (
      <section className={pcss.page}>
        {back}
        <h1 className={css.heading}>Задача не найдена</h1>
        <p className={pcss.muted}>
          Её могли удалить, или адрес неверный. <Link to={project}>Открыть карточку проекта «{d.title}»</Link>.
        </p>
      </section>
    )
  }

  return <TaskBody slug={slug} title={d.title} task={task} milestones={d.milestones ?? []} ro={ro} save={save} onGone={() => navigate(project, { replace: true })} />
}

interface BodyProps {
  slug: string
  title: string
  task: Task
  milestones: Milestone[]
  ro: boolean
  save: Save
  onGone(): void
}

function TaskBody({ slug, title: projectTitle, task, milestones, ro, save, onGone }: BodyProps) {
  const key = `task:${slug}:${task.id}`
  const [error, setError] = useState<string | null>(null)
  const [editingDue, setEditingDue] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = taskStatus(task)
  const info = taskDue(task, new Date())
  const known = milestones.some((m) => m.id === task.milestoneId)

  async function run(patch: Parameters<Save>[0] | null) {
    if (!patch) return null
    setError(null)
    const err = await save(patch)
    setError(err)
    return err
  }

  async function remove() {
    const name = task.title.length > 60 ? `${task.title.slice(0, 60)}…` : task.title
    if (!window.confirm(`Удалить задачу «${name}»?`)) return
    setBusy(true)
    const err = await run({ taskRemove: [task.id] })
    setBusy(false)
    if (!err) onGone()
  }

  return (
    <section className={`${pcss.page} ${css.page}`}>
      <nav className={css.crumbs} aria-label="Путь">
        <Link to={`/projects/${slug}`} className={css.crumbLink}>
          <ArrowLeft size={16} aria-hidden /> {projectTitle}
        </Link>
        <CaretRight size={12} aria-hidden />
        <span>Задача</span>
      </nav>

      <h1 className={css.heading} data-status={status}>
        <InlineText
          value={task.title}
          placeholder="Без названия"
          label="Название задачи"
          maxLength={TASK_TITLE_MAX}
          readOnly={ro}
          trigger="pencil"
          draftKey={`${key}:title`}
          onSave={(t) => save({ taskSet: [{ id: task.id, title: t }] })}
        />
      </h1>

      <div className={css.props}>
        <div className={css.prop}>
          <span className={css.k}>Статус</span>
          <div className={css.segment} role="group" aria-label="Статус задачи">
            {TASK_STATUSES.map((s) => (
              <button key={s} type="button" aria-pressed={status === s} data-task-status={s} disabled={ro} onClick={() => void run(setTaskStatus(task, s))}>
                <span className={css.dot} aria-hidden />
                {TASK_STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        <div className={css.prop}>
          <span className={css.k}>Срок</span>
          <div className={css.value}>
            {editingDue ? (
              <DueForm
                due={task.due}
                label="Срок задачи"
                onCommit={async (due) => {
                  const patch = setTaskDue(task, due)
                  return patch ? run(patch) : null
                }}
                onClose={() => setEditingDue(false)}
              />
            ) : (
              <>
                <span className={css.due} data-overdue={info?.overdue || undefined} data-today={info?.today || undefined}>
                  {info ? info.text : 'без срока'}
                </span>
                {info?.movedFrom && <span className={css.moved}>перенесено с {info.movedFrom}</span>}
                {!ro && (
                  <button type="button" className={pcss.textButton} onClick={() => setEditingDue(true)} aria-label={info ? 'Изменить срок задачи' : 'Задать срок задачи'}>
                    <PencilSimple size={15} aria-hidden /> {info ? 'Изменить' : 'Задать'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className={css.prop}>
          <span className={css.k}>Веха</span>
          <div className={css.value}>
            {ro || milestones.length === 0 ? (
              <span>{milestones.find((m) => m.id === task.milestoneId)?.title ?? 'без вехи'}</span>
            ) : (
              <select
                className={css.select}
                aria-label="Веха задачи"
                value={known ? task.milestoneId : ''}
                onChange={(e) => void run({ taskSet: [{ id: task.id, milestoneId: e.target.value || null }] })}
              >
                <option value="">Без вехи</option>
                {milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p className={pcss.error} role="alert">
          {error}
        </p>
      )}

      <Description draftKey={`${key}:description`} text={task.description ?? ''} readOnly={ro} onSave={(description) => save({ taskSet: [{ id: task.id, description }] })} />

      <LinksEditor draftKey={key} links={task.links ?? []} readOnly={ro} commit={(links) => save({ taskSet: [{ id: task.id, links }] })} />

      <Comments draftKey={`${key}:comment`} comments={task.comments ?? []} readOnly={ro} commit={(comments) => save({ taskSet: [{ id: task.id, comments }] })} />

      {!ro && (
        <div className={pcss.dangerZone}>
          <button type="button" className={pcss.danger} onClick={() => void remove()} disabled={busy}>
            <Trash size={18} aria-hidden /> {busy ? 'Удаляю…' : 'Удалить задачу'}
          </button>
        </div>
      )}
    </section>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className={pcss.section}>
      <h2 className={pcss.sectionTitle}>
        {title}
        {count !== undefined && count > 0 && <span> · {count}</span>}
      </h2>
      {children}
    </section>
  )
}

function Description({ draftKey, text, readOnly, onSave }: { draftKey: string; text: string; readOnly: boolean; onSave(text: string): Promise<string | null> }) {
  // Черновик описания от прошлой версии хаба (ADR-011) — сразу открыть поле с ним.
  const [editing, setEditing] = useState(() => !readOnly && restoredDraft(draftKey) !== undefined)
  return (
    <Section title="Описание">
      {editing ? (
        <InlineText value={text} placeholder="" label="Описание задачи" maxLength={TASK_DESCRIPTION_MAX} multiline autoOpen draftKey={draftKey} onClose={() => setEditing(false)} onSave={onSave} />
      ) : (
        <>
          {text ? (
            <Suspense fallback={<p className={pcss.plain}>{text}</p>}>
              <Markdown text={text} />
            </Suspense>
          ) : (
            <p className={pcss.muted}>Описания пока нет. Можно Markdown: списки, ссылки, код.</p>
          )}
          {!readOnly && (
            <button type="button" className={pcss.textButton} onClick={() => setEditing(true)} aria-label={text ? 'Изменить описание задачи' : undefined}>
              <PencilSimple size={15} aria-hidden /> {text ? 'Изменить' : 'Добавить описание'}
            </button>
          )}
        </>
      )}
    </Section>
  )
}

const at = (c: Comment) => {
  const v = Date.parse(c.at)
  return Number.isNaN(v) ? Infinity : v
}

function Comments({ draftKey, comments, readOnly, commit }: { draftKey: string; comments: Comment[]; readOnly: boolean; commit(next: Comment[]): Promise<string | null> }) {
  const [text, setText] = useDraftText(draftKey, 'Комментарий к задаче')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const feed = [...comments].sort((a, b) => at(a) - at(b))
  const now = new Date()

  async function run(next: Comment[]) {
    setError(null)
    const err = await commit(next)
    setError(err)
    return err
  }

  async function add(e?: FormEvent) {
    e?.preventDefault()
    if (!text.trim()) return
    const c = newComment(text)
    // Поле очищаем сразу: комментарий уже в ленте; не сохранился — текст вернётся в поле.
    setText('')
    if (await run([...comments, c])) setText((cur) => cur || c.text)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter — новая строка (Markdown), Ctrl/Cmd+Enter — отправить.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void add()
    }
  }

  async function remove(c: Comment) {
    if (!window.confirm(`Удалить комментарий «${c.text.slice(0, 60)}${c.text.length > 60 ? '…' : ''}»?`)) return
    await run(comments.filter((x) => x.id !== c.id))
  }

  return (
    <Section title="Комментарии" count={comments.length}>
      {feed.length === 0 && <p className={pcss.muted}>Комментариев пока нет.</p>}
      {feed.length > 0 && (
        <ol className={css.feed}>
          {feed.map((c) => {
            const author = commentAuthor(c)
            return (
              <li key={c.id} className={css.comment}>
                <div className={css.commentMeta}>
                  {author && (
                    <span className={css.author} data-author={c.author === 'claude' ? 'claude' : 'other'}>
                      {author}
                    </span>
                  )}
                  <time dateTime={c.at}>{logWhen(c.at, now)}</time>
                  {c.editedAt && <span>изменено</span>}
                  {!readOnly && editing !== c.id && (
                    <span className={css.commentActions}>
                      {c.author === undefined && (
                        <button type="button" className={pcss.iconButton} onClick={() => setEditing(c.id)} aria-label="Изменить комментарий">
                          <PencilSimple size={15} aria-hidden />
                        </button>
                      )}
                      <button type="button" className={pcss.iconButton} onClick={() => void remove(c)} aria-label="Удалить комментарий">
                        <X size={15} aria-hidden />
                      </button>
                    </span>
                  )}
                </div>
                {editing === c.id ? (
                  <InlineText
                    value={c.text}
                    placeholder=""
                    label="Комментарий"
                    maxLength={COMMENT_MAX}
                    multiline
                    autoOpen
                    draftKey={`${draftKey}:${c.id}`}
                    onClose={() => setEditing(null)}
                    onSave={(t) => run(comments.map((x) => (x.id === c.id ? { ...x, text: t, editedAt: nowIso() } : x)))}
                  />
                ) : (
                  <Suspense fallback={<p className={pcss.plain}>{c.text}</p>}>
                    <Markdown text={c.text} />
                  </Suspense>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {!readOnly && (
        <form className={css.composer} onSubmit={add}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={COMMENT_MAX}
            rows={2}
            placeholder="Написать комментарий… (Ctrl+Enter — отправить)"
            aria-label="Текст комментария"
          />
          <button type="submit" className={css.send} disabled={!text.trim()} aria-label="Отправить комментарий">
            <PaperPlaneRight size={18} aria-hidden />
          </button>
        </form>
      )}
      {error && (
        <p className={pcss.error} role="alert">
          {error}
        </p>
      )}
    </Section>
  )
}
