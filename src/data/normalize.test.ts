import { describe, expect, it } from 'vitest'
import type { Project } from '../schema/types'
import { validateProject } from '../schema/validators.js'
import { parseFile, serialize, type WithUnknown } from './model'
import { normalizeProject } from './normalize'

const NOW = '2026-09-24T12:00:00+03:00'
const EARLIER = '2026-09-01T10:00:00+03:00'
const T1 = '01K5TQ0000000000000000C001'
const T2 = '01K5TQ0000000000000000C002'

const project = (extra: Partial<Project> & Record<string, unknown> = {}): WithUnknown<Project> => ({
  schemaVersion: 1,
  slug: 'x',
  title: 'Икс',
  status: 'active',
  createdAt: '2026-08-01T10:00:00+03:00',
  updatedAt: '2026-08-01T10:00:00+03:00',
  ...extra,
})

const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: 'задача', done: false, ...extra })
const tasksOf = (p: WithUnknown<Project>) => p.tasks as unknown as Record<string, unknown>[]

describe('normalizeProject: версия и общие свойства', () => {
  it('ставит schemaVersion 2 и проходит схему', () => {
    const out = normalizeProject(undefined, project())
    expect(out.schemaVersion).toBe(2)
    expect(validateProject(out)).toBe(true)
  })

  it('не мутирует аргументы', () => {
    const prev = project({ tasks: [task(T1, { due: '2026-10-01' })] })
    const next = project({ status: 'done', doneAt: undefined, tasks: [task(T1, { due: '2026-10-05' }), task(T2, { originalDue: '2026-10-01' })] })
    const prevCopy = structuredClone(prev)
    const nextCopy = structuredClone(next)
    normalizeProject(prev, next, NOW)
    expect(prev).toEqual(prevCopy)
    expect(next).toEqual(nextCopy)
    const done = project({ status: 'active', doneAt: EARLIER })
    normalizeProject(undefined, done, NOW)
    expect(done.doneAt).toBe(EARLIER)
  })

  it('незнакомые поля — верхнего уровня и в задачах — сохраняются вместе с порядком ключей', () => {
    const next = project({ futureField: { a: 1 }, tasks: [task(T1, { due: '2026-10-01', futureTaskField: true })] })
    const out = normalizeProject(undefined, next, NOW)
    expect(out.futureField).toEqual({ a: 1 })
    expect(tasksOf(out)[0]).toMatchObject({ futureTaskField: true })
    expect(Object.keys(out)).toEqual(Object.keys(next))
  })

  it('без задач поле tasks не появляется', () => {
    expect('tasks' in normalizeProject(undefined, project(), NOW)).toBe(false)
  })

  it('результат после сериализации читается как v2 и правится', () => {
    const out = normalizeProject(undefined, project({ status: 'done', tasks: [task(T1, { due: '2026-10-01' })] }), NOW)
    expect(parseFile('projects/x.json', 's', serialize(out))).toMatchObject({ ok: true, readOnly: false })
  })
})

describe('normalizeProject: doneAt', () => {
  it('переход не-done → done без даты — ставит now', () => {
    expect(normalizeProject(project(), project({ status: 'done' }), NOW).doneAt).toBe(NOW)
  })

  it('новый проект сразу в «готово» — ставит now', () => {
    expect(normalizeProject(undefined, project({ status: 'done' }), NOW).doneAt).toBe(NOW)
  })

  it('переход в done с уже заданной датой — дату не трогает', () => {
    expect(normalizeProject(project(), project({ status: 'done', doneAt: EARLIER }), NOW).doneAt).toBe(EARLIER)
  })

  it('проект закрыт до v2, правка заголовка — doneAt не появился', () => {
    const prev = project({ status: 'done' })
    const out = normalizeProject(prev, { ...prev, title: 'Новый заголовок' }, NOW)
    expect('doneAt' in out).toBe(false)
    expect(out.schemaVersion).toBe(2)
    expect(validateProject(out)).toBe(true)
  })

  it('уже done с датой — дата сохраняется', () => {
    const prev = project({ schemaVersion: 2, status: 'done', doneAt: EARLIER })
    expect(normalizeProject(prev, { ...prev, title: 'Б' }, NOW).doneAt).toBe(EARLIER)
  })

  it('уход из done — doneAt снимается', () => {
    const prev = project({ schemaVersion: 2, status: 'done', doneAt: EARLIER })
    const out = normalizeProject(prev, { ...prev, status: 'active' }, NOW)
    expect('doneAt' in out).toBe(false)
    expect(validateProject(out)).toBe(true)
  })

  it('doneAt при status ≠ done (слияние, конфликт «не готово») — снимается, даже если prev был done', () => {
    for (const status of ['idea', 'active', 'paused', 'archived'] as const) {
      const out = normalizeProject(project({ status: 'done', doneAt: EARLIER }), project({ status, doneAt: EARLIER }), NOW)
      expect('doneAt' in out, status).toBe(false)
    }
  })

  it('без prev и не done — doneAt не ставится', () => {
    expect('doneAt' in normalizeProject(undefined, project(), NOW)).toBe(false)
  })

  it('now по умолчанию — текущий момент в ISO со смещением', () => {
    expect(normalizeProject(project(), project({ status: 'done' })).doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })
})

describe('normalizeProject: originalDue', () => {
  it('задача без due — originalDue снимается', () => {
    const out = normalizeProject(undefined, project({ tasks: [task(T1, { originalDue: '2026-10-01' })] }), NOW)
    expect(tasksOf(out)[0]).toEqual(task(T1))
    expect(validateProject(out)).toBe(true)
  })

  it('срок удалён — originalDue снимается', () => {
    const prev = project({ schemaVersion: 2, tasks: [task(T1, { due: '2026-10-05', originalDue: '2026-10-01' })] })
    const out = normalizeProject(prev, project({ tasks: [task(T1, { originalDue: '2026-10-01' })] }), NOW)
    expect('originalDue' in tasksOf(out)[0]!).toBe(false)
  })

  it('задача без due и без originalDue остаётся тем же объектом', () => {
    const t = task(T1)
    const out = normalizeProject(undefined, project({ tasks: [t] }), NOW)
    expect(tasksOf(out)[0]).toBe(t)
  })

  it('есть originalDue при due — не меняется, даже если в prev другое', () => {
    const prev = project({ tasks: [task(T1, { due: '2026-09-01', originalDue: '2026-08-01' })] })
    const out = normalizeProject(prev, project({ tasks: [task(T1, { due: '2026-10-05', originalDue: '2026-10-01' })] }), NOW)
    expect(tasksOf(out)[0]!.originalDue).toBe('2026-10-01')
  })

  it('нет originalDue — берётся originalDue этой задачи из prev', () => {
    const prev = project({ schemaVersion: 2, tasks: [task(T1, { due: '2026-10-03', originalDue: '2026-10-01' })] })
    const out = normalizeProject(prev, project({ tasks: [task(T1, { due: '2026-10-09' })] }), NOW)
    expect(tasksOf(out)[0]!.originalDue).toBe('2026-10-01')
  })

  it('срок перенесён в файле v1 — originalDue = старый due', () => {
    const prev = project({ tasks: [task(T1, { due: '2026-10-01' })] })
    const out = normalizeProject(prev, project({ tasks: [task(T1, { due: '2026-10-15' })] }), NOW)
    expect(tasksOf(out)[0]).toMatchObject({ due: '2026-10-15', originalDue: '2026-10-01' })
    expect(validateProject(out)).toBe(true)
  })

  it('в prev у задачи не было срока — originalDue = текущий due; был — прошлый due', () => {
    const prev = project({ tasks: [task(T2, { due: '2026-09-01' }), task(T1)] })
    const out = normalizeProject(prev, project({ tasks: [task(T1, { due: '2026-10-07' }), task(T2, { due: '2026-09-20' })] }), NOW)
    expect(tasksOf(out)[0]!.originalDue).toBe('2026-10-07')
    expect(tasksOf(out)[1]!.originalDue).toBe('2026-09-01')
  })

  it('задачи не было в prev — originalDue = due', () => {
    const prev = project({ tasks: [task(T2, { due: '2026-09-01' })] })
    const out = normalizeProject(prev, project({ tasks: [task(T1, { due: '2026-10-07' })] }), NOW)
    expect(tasksOf(out)[0]!.originalDue).toBe('2026-10-07')
  })

  it('новый проект (prev нет) — originalDue = due', () => {
    const out = normalizeProject(undefined, project({ tasks: [task(T1, { due: '2026-10-07' })] }), NOW)
    expect(tasksOf(out)[0]!.originalDue).toBe('2026-10-07')
  })

  it('задачи сопоставляются по id, а не по позиции', () => {
    const prev = project({ tasks: [task(T1, { due: '2026-10-01' }), task(T2, { due: '2026-11-01' })] })
    const out = normalizeProject(prev, project({ tasks: [task(T2, { due: '2026-11-20' }), task(T1, { due: '2026-10-20' })] }), NOW)
    expect(tasksOf(out).map((t) => t.originalDue)).toEqual(['2026-11-01', '2026-10-01'])
  })

  it('вехи не трогает: originalDue вехам не ставится', () => {
    const milestones = [{ id: '01K5TQ0000000000000000B001', title: 'в', due: '2026-10-01' }]
    const out = normalizeProject(undefined, project({ milestones }), NOW)
    expect(out.milestones).toEqual(milestones)
  })

  it('мусор в tasks из недоверенного файла не роняет функцию', () => {
    const next = project({ tasks: [null, 'строка', task(T1, { due: '2026-10-01' })] as never })
    const out = normalizeProject(project({ tasks: [null] as never }), next, NOW)
    expect(tasksOf(out).slice(0, 2)).toEqual([null, 'строка'])
    expect(tasksOf(out)[2]!.originalDue).toBe('2026-10-01')
  })
})
