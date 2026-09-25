import { describe, expect, it } from 'vitest'
import { buildLibrary } from './projects'
import {
  activityByProject,
  dayOf,
  deadlines,
  isPeriod,
  logCount,
  percentText,
  periodRange,
  published,
  rangeLabel,
  statsPulse,
  taskOutcome,
  tasksClosed,
  type Range,
} from './stats'

const TODAY = new Date(2026, 8, 23, 14, 32) // среда, 23.09.2026
const QUARTER: Range = { start: '2026-06-23', end: '2026-09-23' }

let n = 0
function project(slug: string, extra: object = {}) {
  n++
  return {
    path: `projects/${slug}.json`,
    sha: `sha${n}`,
    text: JSON.stringify({
      schemaVersion: 2,
      slug,
      title: slug.toUpperCase(),
      status: 'active',
      createdAt: '2026-01-10T10:00:00+03:00',
      updatedAt: '2026-01-10T10:00:00+03:00',
      ...extra,
    }),
  }
}

const lib = (files: ReturnType<typeof project>[]) => {
  const l = buildLibrary(files, TODAY)
  expect(l.broken).toEqual([])
  return l.projects
}
const id = (c: string, i = 0) => '01J' + c.repeat(22) + '0123456789'[i]
/** Местный момент в ISO со смещением — тесты не зависят от пояса машины. */
function at(y: number, m: number, d: number, h = 12, min = 0): string {
  const t = new Date(y, m - 1, d, h, min)
  const off = -t.getTimezoneOffset()
  const p = (x: number) => String(Math.abs(x)).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}T${p(h)}:${p(min)}:00${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`
}
const log = (moments: string[]) => moments.map((a, i) => ({ id: id('K', i), at: a, kind: 'done', text: `запись ${i}` }))

describe('periodRange и rangeLabel', () => {
  it('квартал — тот же день три месяца назад, включительно', () => {
    expect(periodRange('quarter', TODAY)).toEqual(QUARTER)
    expect(rangeLabel(QUARTER)).toBe('23.06 — 23.09.2026')
  })

  it('месяц и полгода', () => {
    expect(periodRange('month', TODAY)).toEqual({ start: '2026-08-23', end: '2026-09-23' })
    expect(periodRange('half', TODAY)).toEqual({ start: '2026-03-23', end: '2026-09-23' })
  })

  it('несуществующий день берётся последним днём месяца, без перескока', () => {
    expect(periodRange('quarter', new Date(2026, 4, 31)).start).toBe('2026-02-28')
    expect(periodRange('month', new Date(2028, 2, 31)).start).toBe('2028-02-29')
    expect(periodRange('month', new Date(2026, 6, 31)).start).toBe('2026-06-30')
  })

  it('через границу года — год у обеих дат', () => {
    const r = periodRange('half', new Date(2026, 1, 10))
    expect(r).toEqual({ start: '2025-08-10', end: '2026-02-10' })
    expect(rangeLabel(r)).toBe('10.08.2025 — 10.02.2026')
  })

  it('isPeriod пропускает только известные периоды', () => {
    expect(isPeriod('half')).toBe(true)
    expect(isPeriod('year')).toBe(false)
    expect(isPeriod(null)).toBe(false)
  })
})

describe('dayOf', () => {
  it('переводит момент в местную дату', () => {
    expect(dayOf(at(2026, 9, 23, 0, 0))).toBe('2026-09-23')
    expect(dayOf(at(2026, 9, 22, 23, 59))).toBe('2026-09-22')
  })

  it('пустой и нечитаемый момент — null', () => {
    expect(dayOf(undefined)).toBeNull()
    expect(dayOf('вчера')).toBeNull()
  })
})

describe('пустые данные', () => {
  it('нет проектов — нули и прочерк', () => {
    expect(logCount([], QUARTER)).toBe(0)
    expect(tasksClosed([], QUARTER)).toBe(0)
    const d = deadlines([], QUARTER)
    expect(d).toEqual({ counts: { onTime: 0, moved: 0, missed: 0 }, total: 0, onTimeShare: null })
    expect(percentText(d.onTimeShare)).toBe('—')
    expect(activityByProject([], QUARTER)).toEqual([])
    expect(published([], QUARTER)).toEqual([])
    const p = statsPulse([], QUARTER)
    expect(p.max).toBe(0)
    expect(p.weeks.flat().every((d) => d.level === 0)).toBe(true)
  })

  it('проект без задач и лога ничего не добавляет', () => {
    const ps = lib([project('empty')])
    expect(logCount(ps, QUARTER)).toBe(0)
    expect(tasksClosed(ps, QUARTER)).toBe(0)
    expect(deadlines(ps, QUARTER).total).toBe(0)
    expect(activityByProject(ps, QUARTER)).toEqual([])
  })
})

describe('logCount', () => {
  it('границы периода — по местному дню, включительно', () => {
    const ps = lib([
      project('a', {
        log: log([
          at(2026, 6, 22, 23, 59), // день до начала
          at(2026, 6, 23, 0, 0), // первый день
          at(2026, 9, 23, 23, 59), // последний день
          at(2026, 9, 24, 0, 0), // завтра
        ]),
      }),
      project('b', { status: 'archived', log: log([at(2026, 8, 1)]) }),
    ])
    expect(logCount(ps, QUARTER)).toBe(3)
  })
})

describe('tasksClosed', () => {
  it('считает закрытые с doneAt в периоде; без doneAt и открытые — нет', () => {
    const ps = lib([
      project('a', {
        tasks: [
          { id: id('T', 0), title: 'в периоде', done: true, doneAt: at(2026, 6, 23, 0, 0) },
          { id: id('T', 1), title: 'до периода', done: true, doneAt: at(2026, 6, 22, 23, 59) },
          { id: id('T', 2), title: 'без даты', done: true },
          { id: id('T', 3), title: 'открыта', done: false },
        ],
      }),
    ])
    expect(tasksClosed(ps, QUARTER)).toBe(1)
  })
})

describe('taskOutcome', () => {
  const T = '2026-09-23'
  it('без срока — null', () => {
    expect(taskOutcome({ done: true, doneAt: at(2026, 9, 1) }, T)).toBeNull()
  })

  it('закрыта в день первого срока — в срок', () => {
    expect(taskOutcome({ done: true, due: '2026-09-10', originalDue: '2026-09-10', doneAt: at(2026, 9, 10, 23, 59) }, T)).toEqual({
      outcome: 'onTime',
      day: '2026-09-10',
    })
  })

  it('закрыта на следующий день после срока без переноса — сорвано', () => {
    expect(taskOutcome({ done: true, due: '2026-09-10', originalDue: '2026-09-10', doneAt: at(2026, 9, 11, 0, 0) }, T)?.outcome).toBe('missed')
  })

  it('перенесена и закрыта к новому сроку — перенесено; позже нового — сорвано', () => {
    const t = { done: true, due: '2026-09-15', originalDue: '2026-09-10' }
    expect(taskOutcome({ ...t, doneAt: at(2026, 9, 15) }, T)?.outcome).toBe('moved')
    expect(taskOutcome({ ...t, doneAt: at(2026, 9, 16) }, T)?.outcome).toBe('missed')
    expect(taskOutcome({ ...t, doneAt: at(2026, 9, 9) }, T)?.outcome).toBe('onTime')
  })

  it('срок передвинут раньше — не перенос', () => {
    expect(taskOutcome({ done: true, due: '2026-09-05', originalDue: '2026-09-10', doneAt: at(2026, 9, 8) }, T)?.outcome).toBe('missed')
  })

  it('без originalDue первым сроком считается due', () => {
    expect(taskOutcome({ done: true, due: '2026-09-10', doneAt: at(2026, 9, 10) }, T)?.outcome).toBe('onTime')
  })

  it('закрыта без doneAt — итог не ясен', () => {
    expect(taskOutcome({ done: true, due: '2026-09-10', originalDue: '2026-09-10' }, T)).toBeNull()
  })

  it('открыта: срок сегодня — ещё впереди, вчера — сорвано', () => {
    expect(taskOutcome({ done: false, due: T, originalDue: T }, T)).toBeNull()
    expect(taskOutcome({ done: false, due: '2026-09-22', originalDue: '2026-09-22' }, T)).toEqual({ outcome: 'missed', day: '2026-09-22' })
  })

  it('открыта и перенесена: день — первый срок, но не позже сегодня', () => {
    expect(taskOutcome({ done: false, due: '2026-09-30', originalDue: '2026-09-20' }, T)).toEqual({ outcome: 'moved', day: '2026-09-20' })
    expect(taskOutcome({ done: false, due: '2026-10-30', originalDue: '2026-10-01' }, T)).toEqual({ outcome: 'moved', day: T })
  })
})

describe('deadlines', () => {
  it('считает итоги, день которых в периоде, и долю в срок', () => {
    const ps = lib([
      project('a', {
        tasks: [
          { id: id('D', 0), title: 'в срок', done: true, due: '2026-09-10', originalDue: '2026-09-10', doneAt: at(2026, 9, 9) },
          { id: id('D', 1), title: 'в срок', done: true, due: '2026-07-10', originalDue: '2026-07-10', doneAt: at(2026, 7, 1) },
          { id: id('D', 2), title: 'в срок', done: true, due: '2026-08-10', originalDue: '2026-08-10', doneAt: at(2026, 8, 10) },
          { id: id('D', 3), title: 'перенос', done: true, due: '2026-09-15', originalDue: '2026-09-10', doneAt: at(2026, 9, 14) },
          { id: id('D', 4), title: 'просрочена', done: false, due: '2026-09-01', originalDue: '2026-09-01' },
          { id: id('D', 5), title: 'до периода', done: true, due: '2026-06-01', originalDue: '2026-06-01', doneAt: at(2026, 6, 1) },
          { id: id('D', 6), title: 'впереди', done: false, due: '2026-10-01', originalDue: '2026-10-01' },
          { id: id('D', 7), title: 'без срока', done: true, doneAt: at(2026, 9, 1) },
        ],
      }),
    ])
    const d = deadlines(ps, QUARTER)
    expect(d.counts).toEqual({ onTime: 3, moved: 1, missed: 1 })
    expect(d.total).toBe(5)
    expect(percentText(d.onTimeShare)).toBe('60%')
  })
})

describe('activityByProject', () => {
  it('только записи периода, активные сверху, при равенстве — по алфавиту, без пустых', () => {
    const ps = lib([
      project('b', { log: log([at(2026, 9, 1), at(2026, 9, 2)]) }),
      project('a', { log: log([at(2026, 9, 3), at(2026, 9, 4), at(2026, 5, 1)]) }),
      project('c', { log: log([at(2026, 9, 5), at(2026, 9, 6), at(2026, 9, 7), at(2026, 9, 8)]) }),
      project('z', { log: log([at(2026, 1, 5)]) }),
    ])
    const rows = activityByProject(ps, QUARTER)
    expect(rows.map((r) => [r.slug, r.count, r.share])).toEqual([
      ['c', 4, 1],
      ['a', 2, 0.5],
      ['b', 2, 0.5],
    ])
  })
})

describe('published', () => {
  it('готовые проекты с doneAt в периоде, свежие сверху; без doneAt — нет', () => {
    const ps = lib([
      project('old', { status: 'done', doneAt: at(2026, 6, 22, 23, 59) }),
      project('first', { status: 'done', doneAt: at(2026, 6, 23, 0, 0) }),
      project('fresh', { status: 'done', doneAt: at(2026, 9, 23, 23, 0) }),
      project('nodate', { status: 'done' }),
      project('active'),
    ])
    expect(published(ps, QUARTER)).toEqual([
      { slug: 'fresh', title: 'FRESH', day: '2026-09-23' },
      { slug: 'first', title: 'FIRST', day: '2026-06-23' },
    ])
  })
})

describe('statsPulse', () => {
  it('недели с понедельника недели начала до текущей; дни вне периода помечены', () => {
    const ps = lib([project('a', { log: log([at(2026, 6, 22), at(2026, 6, 23), at(2026, 9, 23), at(2026, 9, 23, 20)]) })])
    const p = statsPulse(ps, QUARTER)
    // 23.06.2026 — вторник: первая неделя с 22.06, последняя с 21.09.
    expect(p.weeks).toHaveLength(14)
    expect(p.weeks.every((w) => w.length === 7)).toBe(true)
    const first = p.weeks[0]!
    expect(first[0]).toMatchObject({ date: '2026-06-22', out: true, count: 0 })
    expect(first[1]).toMatchObject({ date: '2026-06-23', out: false, count: 1, level: 2 })
    const last = p.weeks[13]!
    expect(last[2]).toMatchObject({ date: '2026-09-23', out: false, count: 2, level: 4 })
    expect(last[3]).toMatchObject({ date: '2026-09-24', out: true })
    expect(p.max).toBe(2)
  })

  it('период с понедельника по воскресенье — ровно одна неделя', () => {
    const p = statsPulse([], { start: '2026-09-21', end: '2026-09-27' })
    expect(p.weeks).toHaveLength(1)
    expect(p.weeks[0]!.every((d) => !d.out)).toBe(true)
  })

  it('переход на летнее время не сдвигает даты', () => {
    const days = statsPulse([], { start: '2026-03-20', end: '2026-04-05' }).weeks.flat().map((d) => d.date)
    expect(new Set(days).size).toBe(days.length)
    expect(days).toContain('2026-03-29')
    expect(days).toContain('2026-03-30')
  })
})
