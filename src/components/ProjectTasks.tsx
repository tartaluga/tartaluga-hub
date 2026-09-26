// Задачи проекта в карточке (D1, D2): список, отметка «сделано», срок, правка названия, удаление; вехи — группы задач.
// Срок подписывается как в «Горит» на экране «Сегодня» (макет 1a): моно, просроченный — маджентой. Первый срок
// (originalDue) ведёт normalizeProject при записи — здесь он только показывается: «перенесено с 21.09».
// Вехи идут в порядке файла, задачи без вехи (или с id вехи, которой нет) — в группе «Без вехи» в конце.
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, Flag, Plus, X } from '@phosphor-icons/react'
import {
  MILESTONE_TITLE_MAX,
  newMilestone,
  newTask,
  TASK_TITLE_MAX,
  taskDue,
  taskProgress,
  toggleTask,
  type ProjectPatch,
} from '../data/editProject'
import type { Milestone, Task } from '../schema/types'
import { InlineText } from './InlineText'
import { restoredDraft, useDraft } from '../lib/drafts'
import css from './ProjectTasks.module.css'

interface Props {
  tasks: Task[]
  milestones?: Milestone[]
  readOnly: boolean
  save(patch: ProjectPatch): Promise<string | null>
  /** «Сегодня» для подписей сроков; в тестах — фиксированная дата. */
  today?: Date
  /** Префикс ключей черновиков формы добавления (ADR-011), например `project:<slug>`; нет — черновики не отдаются. */
  draftKey?: string
}

type Run = (patch: ProjectPatch) => Promise<string | null>

/** Поле формы добавления: с ключом — стартует с черновика и отдаёт непустой текст в handoff (как useDraftText). */
function useFieldText(key: string | null, label: string): [string, (next: string | ((cur: string) => string)) => void] {
  const [text, setText] = useState(() => (key === null ? undefined : restoredDraft(key)) ?? '')
  useDraft(key, text === '' ? undefined : text, label)
  return [text, setText]
}

const restoredAny = (...keys: (string | null)[]) => keys.some((k) => k !== null && restoredDraft(k) !== undefined)

const taskKeys = (prefix: string | undefined, milestone: Milestone | null | undefined) => {
  if (prefix === undefined) return { title: null, due: null }
  const group = milestone === undefined ? 'all' : milestone === null ? 'none' : `m:${milestone.id}`
  return { title: `${prefix}:new-task:${group}:title`, due: `${prefix}:new-task:${group}:due` }
}

const milestoneKeys = (prefix: string | undefined) =>
  prefix === undefined ? { title: null, due: null } : { title: `${prefix}:new-milestone:title`, due: `${prefix}:new-milestone:due` }

/** Больше задач — полоса вехи сплошная с заливкой, а не по сегменту на задачу. */
export const SEGMENTS_MAX = 20

export function ProjectTasks({ tasks, milestones = [], readOnly, save, today = new Date(), draftKey }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [addingMilestone, setAddingMilestone] = useState(() => {
    const k = milestoneKeys(draftKey)
    return !readOnly && restoredAny(k.title, k.due)
  })
  const progress = taskProgress(tasks)

  async function run(patch: ProjectPatch) {
    setError(null)
    const err = await save(patch)
    setError(err)
    return err
  }

  async function remove(task: Task) {
    if (!window.confirm(`Удалить задачу «${task.title.slice(0, 60)}${task.title.length > 60 ? '…' : ''}»?`)) return
    await run({ taskRemove: [task.id] })
  }

  const list = (items: Task[]) => (
    <ul className={css.list}>
      {items.map((t) => (
        <TaskRow key={t.id} task={t} today={today} readOnly={readOnly} milestones={milestones} run={run} onRemove={() => void remove(t)} />
      ))}
    </ul>
  )

  const known = new Set(milestones.map((m) => m.id))
  const loose = tasks.filter((t) => !t.milestoneId || !known.has(t.milestoneId))

  return (
    <section className={css.section}>
      <h2 className={css.title}>
        Задачи{progress.total > 0 && <span className={css.count}> · {progress.done}/{progress.total}</span>}
      </h2>
      {milestones.length === 0 ? (
        <>
          {tasks.length === 0 ? (
            <p className={css.muted}>{readOnly ? 'Задач нет.' : 'Задач пока нет. Добавь первую — со сроком она попадёт в «Горит».'}</p>
          ) : (
            list(tasks)
          )}
          {!readOnly && <AddTask run={run} draftKey={draftKey} />}
        </>
      ) : (
        <>
          {/* Подпись и разделители между группами: вехи и задачи не сливаются в один список. */}
          <h3 className={css.groupsLabel}>Вехи · {milestones.length}</h3>
          {milestones.map((m) => {
            const own = tasks.filter((t) => t.milestoneId === m.id)
            return (
              <div key={m.id} className={css.group}>
                <MilestoneHead milestone={m} tasks={own} today={today} readOnly={readOnly} run={run} />
                {own.length > 0 && list(own)}
                {!readOnly && <AddTask run={run} milestone={m} draftKey={draftKey} />}
              </div>
            )
          })}
          {(loose.length > 0 || !readOnly) && (
            <div className={css.group}>
              <h3 className={css.groupTitle}>Без вехи</h3>
              {loose.length > 0 && list(loose)}
              {!readOnly && <AddTask run={run} milestone={null} draftKey={draftKey} />}
            </div>
          )}
        </>
      )}
      {!readOnly &&
        (addingMilestone ? (
          <AddMilestone run={run} draftKey={draftKey} onClose={() => setAddingMilestone(false)} />
        ) : (
          <button type="button" className={css.textButton} onClick={() => setAddingMilestone(true)}>
            <Plus size={14} aria-hidden /> Веха
          </button>
        ))}
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * Новая задача. Без вех — форма видна всегда. В группе вехи — сначала кнопка «+ задача», форма открывается по ней
 * и задача получает milestoneId группы (null — группа «Без вехи»).
 */
function AddTask({ run, milestone, draftKey }: { run: Run; milestone?: Milestone | null; draftKey?: string }) {
  const grouped = milestone !== undefined
  const where = milestone ? `в «${milestone.title}»` : 'без вехи'
  const keys = taskKeys(draftKey, milestone)
  const [open, setOpen] = useState(() => !grouped || restoredAny(keys.title, keys.due))
  return open ? <AddTaskForm run={run} milestone={milestone} keys={keys} onClose={() => setOpen(false)} /> : (
    <button type="button" className={css.textButton} onClick={() => setOpen(true)} aria-label={`Добавить задачу ${where}`}>
      <Plus size={14} aria-hidden /> задача
    </button>
  )
}

/** Форма новой задачи — отдельно, чтобы черновик жил, пока форма открыта, и уходил, когда её закрыли. */
function AddTaskForm({ run, milestone, keys, onClose }: { run: Run; milestone?: Milestone | null; keys: ReturnType<typeof taskKeys>; onClose(): void }) {
  const grouped = milestone !== undefined
  const where = milestone ? `в «${milestone.title}»` : 'без вехи'
  const [title, setTitle] = useFieldText(keys.title, grouped ? `Новая задача ${where}` : 'Новая задача')
  const [due, setDue] = useFieldText(keys.due, 'Срок новой задачи')

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const task = newTask(title, due || undefined, milestone?.id)
    // Поля очищаем сразу: задача уже в списке; если не сохранилась — ввод вернётся.
    setTitle('')
    setDue('')
    if (await run({ taskAdd: [task] })) {
      setTitle((cur) => cur || task.title)
      setDue((cur) => cur || task.due || '')
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (grouped && e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <form className={css.add} onSubmit={add} onKeyDown={onKeyDown}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={TASK_TITLE_MAX}
        placeholder="Новая задача…"
        aria-label={grouped ? `Новая задача ${where}` : 'Новая задача'}
        autoFocus={grouped}
      />
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Срок новой задачи" className={css.date} />
      <button type="submit" className={css.addButton} disabled={!title.trim()} aria-label={grouped ? `Добавить задачу ${where}` : 'Добавить задачу'}>
        <Plus size={16} aria-hidden />
      </button>
    </form>
  )
}

function AddMilestone({ run, onClose, draftKey }: { run: Run; onClose(): void; draftKey?: string }) {
  const keys = milestoneKeys(draftKey)
  const [title, setTitle] = useFieldText(keys.title, 'Новая веха')
  const [due, setDue] = useFieldText(keys.due, 'Срок новой вехи')

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const m = newMilestone(title, due || undefined)
    setTitle('')
    setDue('')
    if (await run({ milestoneAdd: [m] })) {
      setTitle((cur) => cur || m.title)
      setDue((cur) => cur || m.due || '')
    } else onClose()
  }

  return (
    <form
      className={css.add}
      onSubmit={add}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MILESTONE_TITLE_MAX} placeholder="Новая веха…" aria-label="Новая веха" autoFocus />
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Срок новой вехи" className={css.date} />
      <button type="submit" className={css.addButton} disabled={!title.trim()} aria-label="Добавить веху">
        <Plus size={16} aria-hidden />
      </button>
    </form>
  )
}

interface HeadProps {
  milestone: Milestone
  tasks: Task[]
  today: Date
  readOnly: boolean
  run: Run
}

/** Шапка вехи: название, срок, сегментная полоса прогресса Визора, «3/7», удаление с подтверждением. */
function MilestoneHead({ milestone: m, tasks, today, readOnly, run }: HeadProps) {
  const [editingDue, setEditingDue] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const progress = taskProgress(tasks)
  const allDone = progress.total > 0 && progress.done === progress.total
  const info = taskDue({ due: m.due, done: allDone }, today)

  return (
    <div className={css.msHead} data-overdue={info?.overdue || undefined} data-today={info?.today || undefined} data-done={allDone || undefined}>
      <InlineText
        value={m.title}
        placeholder="Без названия"
        label="Название вехи"
        maxLength={MILESTONE_TITLE_MAX}
        readOnly={readOnly}
        className={css.msTitle}
        onSave={(title) => run({ milestoneSet: [{ id: m.id, title }] })}
      />
      {editingDue ? (
        <DueForm due={m.due} label="Срок вехи" onCommit={(due) => run({ milestoneSet: [{ id: m.id, due }] })} onClose={() => setEditingDue(false)} />
      ) : readOnly ? (
        info && <span className={css.due}>{info.text}</span>
      ) : (
        <button
          type="button"
          className={css.due}
          data-empty={info ? undefined : true}
          onClick={() => setEditingDue(true)}
          aria-label={info ? `Срок вехи: ${info.text}. Изменить срок` : `Задать срок вехи ${m.title}`}
        >
          {info?.text ?? 'срок'}
        </button>
      )}
      <span className={css.msCount}>
        {progress.done}/{progress.total}
      </span>
      {!readOnly && (
        <button type="button" className={css.remove} onClick={() => setConfirming(true)} aria-label={`Удалить веху ${m.title}`}>
          <X size={14} aria-hidden />
        </button>
      )}
      <Progress done={progress.done} total={progress.total} />
      {confirming && (
        <div className={css.confirm} role="group" aria-label="Подтверди удаление вехи">
          <span>Удалить веху? Задачи останутся — без вехи.</span>
          <button
            type="button"
            className={css.small}
            data-danger
            autoFocus
            onClick={async () => {
              if (!(await run({ milestoneRemove: [m.id] }))) setConfirming(false)
            }}
          >
            Удалить
          </button>
          <button type="button" className={css.small} onClick={() => setConfirming(false)}>
            Отмена
          </button>
        </div>
      )}
    </div>
  )
}

/** Полоса прогресса Визора: сегмент на задачу; при большом числе задач — сплошная с заливкой. */
function Progress({ done, total }: { done: number; total: number }) {
  const label = `Сделано ${done} из ${total}`
  if (total === 0 || total > SEGMENTS_MAX) {
    return (
      <div className={css.bar} role="img" aria-label={label}>
        <span className={css.solid}>{total > 0 && <span className={css.fill} style={{ width: `${(done / total) * 100}%` }} />}</span>
      </div>
    )
  }
  return (
    <div className={css.bar} role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={css.seg} data-done={i < done || undefined} />
      ))}
    </div>
  )
}

interface RowProps {
  task: Task
  today: Date
  readOnly: boolean
  milestones: Milestone[]
  run: Run
  onRemove(): void
}

function TaskRow({ task, today, readOnly, milestones, run, onRemove }: RowProps) {
  const [editingDue, setEditingDue] = useState(false)
  const info = taskDue(task, today)
  const known = milestones.some((m) => m.id === task.milestoneId)
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
        <DueForm due={task.due} label="Срок задачи" onCommit={(due) => run({ taskSet: [{ id: task.id, due }] })} onClose={() => setEditingDue(false)} />
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
        <span className={css.actions}>
          {milestones.length > 0 && (
            // Прозрачный select поверх значка: компактно, а выбор — обычный, с клавиатуры и в читалке экрана.
            <span className={css.move} title="Перенести в веху">
              <Flag size={14} aria-hidden />
              <select
                aria-label={`Веха задачи ${task.title}`}
                value={known ? task.milestoneId : ''}
                onChange={(e) => void run({ taskSet: [{ id: task.id, milestoneId: e.target.value || null }] })}
              >
                {milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
                <option value="">Без вехи</option>
              </select>
            </span>
          )}
          <button type="button" className={css.remove} onClick={onRemove} aria-label={`Удалить задачу ${task.title}`}>
            <X size={14} aria-hidden />
          </button>
        </span>
      )}
    </li>
  )
}

/** Правка срока: дата и «Сохранить» (Enter), «Без срока», Esc — отмена. Сохраняем по кнопке, а не на каждое изменение
 *  поля даты: при наборе с клавиатуры поле проходит через промежуточные даты. */
function DueForm({ due, label, onCommit, onClose }: { due: string | undefined; label: string; onCommit(due: string | null): Promise<string | null>; onClose(): void }) {
  const [value, setValue] = useState(due ?? '')
  const [busy, setBusy] = useState(false)

  async function commit(next: string | null) {
    if ((next ?? undefined) === due) return onClose()
    setBusy(true)
    const err = await onCommit(next)
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
      <input type="date" value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} className={css.date} autoFocus />
      <button type="submit" className={css.small} disabled={busy || !value}>
        Сохранить
      </button>
      {due && (
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
