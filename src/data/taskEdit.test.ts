import { describe, expect, it } from 'vitest'
import { buildLibrary } from './projects'
import { deadlines, taskOutcome, tasksClosed } from './stats'
import { applyEdit, mergePatch, normalizePatch, patchError, taskProgress, TASK_LOG_REPLACE_MS, type ProjectPatch } from './editProject'
import { normalizeProject } from './normalize'
import { commentAuthor, isTaskId, logTaskId, newComment, setTaskDue, setTaskStatus, taskStatus, toggleTaskDone } from './taskEdit'
import type { Project, Task } from '../schema/types'
import type { WithUnknown } from './model'

const T = '01K5Y0000000000000000000AA'
const U = '01K5Y0000000000000000000BB'
const NOW = new Date(2026, 9, 4, 12, 0, 0)

const todo: Task = { id: T, title: 'Снять листы', done: false }
const doing: Task = { ...todo, inProgress: true }
const done: Task = { ...todo, done: true, doneAt: '2026-10-01T10:00:00+03:00' }
const cancelled: Task = { ...done, cancelled: true }

describe('taskStatus', () => {
  it('done главный: метки при нём не показываются', () => {
    expect(taskStatus(todo)).toBe('todo')
    expect(taskStatus(doing)).toBe('doing')
    expect(taskStatus(done)).toBe('done')
    expect(taskStatus(cancelled)).toBe('cancelled')
    expect(taskStatus({ ...done, inProgress: true })).toBe('done')
    expect(taskStatus({ ...todo, cancelled: true })).toBe('todo')
  })
})

describe('setTaskStatus', () => {
  it('тот же статус — писать нечего', () => {
    expect(setTaskStatus(doing, 'doing', NOW)).toBeNull()
  })

  it('к выполнению → в работе: метка и запись лога', () => {
    const p = setTaskStatus(todo, 'doing', NOW)!
    expect(p.taskSet).toEqual([{ id: T, done: false, inProgress: true, cancelled: null, doneAt: null }])
    expect(p.logAdd).toEqual([{ id: expect.any(String), at: expect.stringMatching(/^2026-10-04T12:00:00/), kind: 'task', taskId: T, text: '«Снять листы»: в работе' }])
  })

  it('готово ставит doneAt; готово → отменена его не трогает; возврат убирает', () => {
    const d = setTaskStatus(doing, 'done', NOW)!
    expect(d.taskSet).toEqual([{ id: T, done: true, inProgress: null, cancelled: null, doneAt: expect.stringMatching(/^2026-10-04/) }])
    expect(d.logAdd![0]!.text).toBe('«Снять листы»: готово')
    const c = setTaskStatus(done, 'cancelled', NOW)!
    expect(c.taskSet).toEqual([{ id: T, done: true, inProgress: null, cancelled: true }])
    expect(c.logAdd![0]!.text).toBe('«Снять листы»: отменена')
    const back = setTaskStatus(cancelled, 'todo', NOW)!
    expect(back.taskSet).toEqual([{ id: T, done: false, inProgress: null, cancelled: null, doneAt: null }])
    expect(back.logAdd![0]!.text).toBe('«Снять листы»: снова к выполнению')
  })

  it('галочка в списке: сделано ↔ снова к выполнению, у отменённой снимает «отмену»', () => {
    expect(toggleTaskDone(todo, NOW).logAdd![0]!.text).toBe('«Снять листы»: готово')
    expect(toggleTaskDone(done, NOW).logAdd![0]!.text).toBe('«Снять листы»: снова к выполнению')
    expect(toggleTaskDone(cancelled, NOW).taskSet![0]).toMatchObject({ done: false, cancelled: null })
  })

  it('в файле: статусы взаимоисключающие, метки убирает и normalizeProject', () => {
    const file = { schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', tasks: [doing], createdAt: 'x', updatedAt: 'x' } as unknown as WithUnknown<Project>
    const after = applyEdit(file, setTaskStatus(doing, 'cancelled', NOW)!, NOW)
    expect(after.tasks![0]).toMatchObject({ done: true, cancelled: true })
    expect(after.tasks![0]).not.toHaveProperty('inProgress')
    expect(after.log).toHaveLength(1)
    const rough = { ...file, tasks: [{ ...todo, inProgress: true, cancelled: true }, { ...done, inProgress: true, cancelled: true }] } as unknown as WithUnknown<Project>
    const norm = normalizeProject(undefined, rough)
    expect(norm.tasks![0]).not.toHaveProperty('cancelled')
    expect(norm.tasks![1]).not.toHaveProperty('inProgress')
  })

  it('длинное название в логе обрезается', () => {
    const p = setTaskStatus({ ...todo, title: 'я'.repeat(200) }, 'doing', NOW)!
    expect(p.logAdd![0]!.text).toBe(`«${'я'.repeat(80)}…»: в работе`)
  })
})

describe('setTaskDue', () => {
  it('новый срок, перенос, снятие; тот же срок — null', () => {
    expect(setTaskDue({ ...todo, due: '2026-10-05' }, '2026-10-05', NOW)).toBeNull()
    expect(setTaskDue(todo, null, NOW)).toBeNull()
    expect(setTaskDue(todo, '2026-10-12', NOW)!.logAdd![0]!.text).toBe('«Снять листы»: срок 12.10')
    const moved = setTaskDue({ ...todo, due: '2026-10-05' }, '2026-10-12', NOW)!
    expect(moved.taskSet).toEqual([{ id: T, due: '2026-10-12' }])
    expect(moved.logAdd![0]).toMatchObject({ kind: 'task', taskId: T, text: '«Снять листы»: срок 05.10 → 12.10' })
    expect(setTaskDue({ ...todo, due: '2026-10-05' }, null, NOW)!.logAdd![0]!.text).toBe('«Снять листы»: срок снят (было 05.10)')
  })
})

describe('отмена непосланной правки не оставляет двух записей', () => {
  it('галочка и сразу снятая галочка: одна запись о статусе, поля задачи — как после второй правки', () => {
    const on = setTaskStatus(todo, 'done', NOW)!
    const off = setTaskStatus(done, 'todo', new Date(NOW.getTime() + 1500))!
    const m = mergePatch(on, off)
    expect(m.logAdd).toHaveLength(1)
    expect(m.logAdd![0]!.text).toBe('«Снять листы»: снова к выполнению')
    expect(m.taskSet).toEqual([{ id: T, done: false, doneAt: null, inProgress: null, cancelled: null }])
  })

  it('другая тема (срок), другая задача или пауза дольше окна — записи остаются обе', () => {
    const status = setTaskStatus(todo, 'doing', NOW)!
    const due = setTaskDue(todo, '2026-10-12', new Date(NOW.getTime() + 1000))!
    expect(mergePatch(status, due).logAdd).toHaveLength(2)
    const other = setTaskStatus({ ...todo, id: U }, 'doing', new Date(NOW.getTime() + 1000))!
    expect(mergePatch(status, other).logAdd).toHaveLength(2)
    const late = setTaskStatus(doing, 'done', new Date(NOW.getTime() + TASK_LOG_REPLACE_MS + 2000))!
    expect(mergePatch(status, late).logAdd).toHaveLength(2)
  })
})

describe('нормализация и проверка правок задачи', () => {
  it('пустое описание, ссылки и комментарии убирают поля', () => {
    expect(normalizePatch({ taskSet: [{ id: T, description: '  \r\n ', links: [], comments: [] }] }).taskSet).toEqual([{ id: T, description: null, links: null, comments: null }])
    expect(normalizePatch({ taskSet: [{ id: T, description: ' текст\r\nещё ' }] }).taskSet).toEqual([{ id: T, description: 'текст\nещё' }])
  })

  it('пределы: описание 10 000, комментарий 2000 и не пустой', () => {
    expect(patchError({ taskSet: [{ id: T, description: 'a'.repeat(10_000) }] })).toBeNull()
    expect(patchError({ taskSet: [{ id: T, description: 'a'.repeat(10_001) }] })).toMatch(/Описание задачи длиннее/)
    expect(patchError({ taskSet: [{ id: T, comments: [{ id: U, at: 'x', text: 'a'.repeat(2001) }] }] })).toMatch(/Комментарий длиннее/)
    expect(patchError({ taskSet: [{ id: T, comments: [{ id: U, at: 'x', text: '  ' }] }] })).toMatch(/Пустой комментарий/)
  })

  it('поля подробностей ложатся в файл и снимаются null', () => {
    const file = { schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', tasks: [{ ...todo, futureField: 1 }], createdAt: 'x', updatedAt: 'x' } as unknown as WithUnknown<Project>
    const c = newComment('  привет\r\n', NOW)
    const patch: ProjectPatch = { taskSet: [{ id: T, description: 'Текст', comments: [c] }] }
    const after = applyEdit(file, patch, NOW)
    expect(after.tasks![0]).toMatchObject({ futureField: 1, description: 'Текст', comments: [{ text: 'привет' }] })
    const cleared = applyEdit(after, { taskSet: [{ id: T, description: null, comments: null }] }, NOW)
    expect(cleared.tasks![0]).not.toHaveProperty('description')
    expect(cleared.tasks![0]).not.toHaveProperty('comments')
  })
})

describe('комментарии и ссылки из лога', () => {
  it('commentAuthor: нет поля — владелец, claude — «Claude», прочее — «другой»', () => {
    expect(commentAuthor({})).toBeNull()
    expect(commentAuthor({ author: 'claude' })).toBe('Claude')
    expect(commentAuthor({ author: 'bot-x' })).toBe('другой')
  })

  it('logTaskId: ссылка только на настоящий ULID существующей задачи', () => {
    const tasks = [{ id: T }]
    expect(logTaskId({ kind: 'task', taskId: T }, tasks)).toBe(T)
    expect(logTaskId({ kind: 'task', taskId: U }, tasks)).toBeNull()
    expect(logTaskId({ kind: 'task', taskId: '../../x' }, tasks)).toBeNull()
    expect(logTaskId({ kind: 'task' }, tasks)).toBeNull()
    expect(isTaskId(T)).toBe(true)
    expect(isTaskId('abc')).toBe(false)
  })
})

describe('отменённая задача вне прогресса, «в срок» и закрытых', () => {
  it('taskProgress не считает отменённые ни в числителе, ни в знаменателе', () => {
    expect(taskProgress([done, cancelled, todo])).toEqual({ done: 1, total: 2 })
    expect(taskProgress([cancelled])).toEqual({ done: 0, total: 0 })
  })

  it('taskOutcome: у отменённой итога нет, у такой же готовой — есть', () => {
    const dated = { ...done, due: '2026-10-02', originalDue: '2026-10-02' }
    expect(taskOutcome(dated, '2026-10-04')).toMatchObject({ outcome: 'onTime' })
    expect(taskOutcome({ ...dated, cancelled: true }, '2026-10-04')).toBeNull()
  })

  it('прогресс проекта, tasksClosed и deadlines', () => {
    const file = (extra: object) => ({
      path: 'projects/bot.json',
      sha: 's',
      text: JSON.stringify({ schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', createdAt: '2026-01-01T10:00:00+03:00', updatedAt: '2026-01-01T10:00:00+03:00', ...extra }),
    })
    const dated = { ...done, due: '2026-10-02', originalDue: '2026-10-02' }
    const lib = buildLibrary([file({ tasks: [dated, { ...dated, id: U, cancelled: true }, { ...todo, id: '01K5Y0000000000000000000CC' }] })], NOW)
    const p = lib.projects[0]!
    expect([p.tasksDone, p.tasksTotal, p.progress]).toEqual([1, 2, 0.5])
    const range = { start: '2026-09-01', end: '2026-10-04' }
    expect(tasksClosed(lib.projects, range)).toBe(1)
    expect(deadlines(lib.projects, range).counts).toEqual({ onTime: 1, moved: 0, missed: 0 })
  })
})
