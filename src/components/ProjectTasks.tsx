// Задачи проекта в карточке (D1): список в порядке файла, отметка «сделано», срок, правка названия, удаление.
// Срок подписывается как в «Горит» на экране «Сегодня» (макет 1a): моно, просроченный — маджентой. Первый срок
// (originalDue) ведёт normalizeProject при записи — здесь он только показывается: «перенесено с 21.09».
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, Plus, X } from '@phosphor-icons/react'
import { newTask, TASK_TITLE_MAX, taskDue, taskProgress, toggleTask, type ProjectPatch } from '../data/editProject'
import type { Task } from '../schema/types'
import { InlineText } from './InlineText'
import css from './ProjectTasks.module.css'

interface Props {
  tasks: Task[]
  readOnly: boolean
  save(patch: ProjectPatch): Promise<string | null>
  /** «Сегодня» для подписей сроков; в тестах — фиксированная дата. */
  today?: Date
}

export function ProjectTasks({ tasks, readOnly, save, today = new Date() }: Props) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const progress = taskProgress(tasks)

  async function run(patch: ProjectPatch) {
    setError(null)
    const err = await save(patch)
    setError(err)
    return err
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const task = newTask(title, due || undefined)
    // Поля очищаем сразу: задача уже в списке; если не сохранилась — ввод вернётся.
    setTitle('')
    setDue('')
    if (await run({ taskAdd: [task] })) {
      setTitle((cur) => cur || task.title)
      setDue((cur) => cur || task.due || '')
    }
  }

  async function remove(task: Task) {
    if (!window.confirm(`Удалить задачу «${task.title.slice(0, 60)}${task.title.length > 60 ? '…' : ''}»?`)) return
    await run({ taskRemove: [task.id] })
  }

  return (
    <section className={css.section}>
      <h2 className={css.title}>
        Задачи{progress.total > 0 && <span className={css.count}> · {progress.done}/{progress.total}</span>}
      </h2>
      {tasks.length === 0 ? (
        <p className={css.muted}>{readOnly ? 'Задач нет.' : 'Задач пока нет. Добавь первую — со сроком она попадёт в «Горит».'}</p>
      ) : (
        <ul className={css.list}>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} today={today} readOnly={readOnly} run={run} onRemove={() => void remove(t)} />
          ))}
        </ul>
      )}
      {!readOnly && (
        <form className={css.add} onSubmit={add}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TASK_TITLE_MAX} placeholder="Новая задача…" aria-label="Новая задача" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Срок новой задачи" className={css.date} />
          <button type="submit" className={css.addButton} disabled={!title.trim()} aria-label="Добавить задачу">
            <Plus size={16} aria-hidden />
          </button>
        </form>
      )}
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

interface RowProps {
  task: Task
  today: Date
  readOnly: boolean
  run(patch: ProjectPatch): Promise<string | null>
  onRemove(): void
}

function TaskRow({ task, today, readOnly, run, onRemove }: RowProps) {
  const [editingDue, setEditingDue] = useState(false)
  const info = taskDue(task, today)
  return (
    <li className={css.row} data-done={task.done || undefined} data-overdue={info?.overdue || undefined} data-today={info?.today || undefined}>
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        aria-label={`Сделано: ${task.title}`}
        className={css.check}
        disabled={readOnly}
        onClick={() => void run({ taskSet: [toggleTask(task.id, !task.done)] })}
      >
        {task.done && <Check size={14} weight="bold" aria-hidden />}
      </button>
      <div className={css.main}>
        <InlineText
          value={task.title}
          placeholder="Без названия"
          label="Название задачи"
          maxLength={TASK_TITLE_MAX}
          readOnly={readOnly}
          className={css.taskTitle}
          onSave={(title) => run({ taskSet: [{ id: task.id, title }] })}
        />
        {info?.movedFrom && <span className={css.moved}>перенесено с {info.movedFrom}</span>}
      </div>
      {editingDue ? (
        <DueForm task={task} run={run} onClose={() => setEditingDue(false)} />
      ) : readOnly ? (
        info && <span className={css.due}>{info.text}</span>
      ) : (
        <button
          type="button"
          className={css.due}
          data-empty={info ? undefined : true}
          onClick={() => setEditingDue(true)}
          aria-label={info ? `Срок: ${info.text}. Изменить срок` : 'Задать срок'}
        >
          {info?.text ?? 'срок'}
        </button>
      )}
      {!readOnly && (
        <button type="button" className={css.remove} onClick={onRemove} aria-label={`Удалить задачу ${task.title}`}>
          <X size={14} aria-hidden />
        </button>
      )}
    </li>
  )
}

/** Правка срока: дата и «Сохранить» (Enter), «Без срока», Esc — отмена. Сохраняем по кнопке, а не на каждое изменение
 *  поля даты: при наборе с клавиатуры поле проходит через промежуточные даты. */
function DueForm({ task, run, onClose }: { task: Task; run: RowProps['run']; onClose(): void }) {
  const [value, setValue] = useState(task.due ?? '')
  const [busy, setBusy] = useState(false)

  async function commit(due: string | null) {
    if ((due ?? undefined) === task.due) return onClose()
    setBusy(true)
    const err = await run({ taskSet: [{ id: task.id, due }] })
    setBusy(false)
    if (!err) onClose()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <form
      className={css.dueForm}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        if (value) void commit(value)
      }}
    >
      <input type="date" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Срок задачи" className={css.date} autoFocus />
      <button type="submit" className={css.small} disabled={busy || !value}>
        Сохранить
      </button>
      {task.due && (
        <button type="button" className={css.small} disabled={busy} onClick={() => void commit(null)}>
          Без срока
        </button>
      )}
      <button type="button" className={css.small} disabled={busy} onClick={onClose}>
        Отмена
      </button>
    </form>
  )
}
