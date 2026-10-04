import { describe, expect, it } from 'vitest'
import type { Status } from '../schema/types'
import { commitDays, projectCommitDays, sumDays } from './commits'

const status = (projects: Record<string, unknown>): Status =>
  ({ schemaVersion: 1, generatedAt: '2026-09-29T10:00:00Z', lastSuccess: null, errors: [], projects }) as unknown as Status

const repo = (fullName: string, commitsByDay?: unknown) => ({ repo: { fullName, commitsByDay } })

describe('projectCommitDays', () => {
  it('читает дни и пропускает мусор', () => {
    const s = status({
      a: repo('o/a', {
        '2026-09-01': 3,
        '2026-9-2': 1,
        'вчера': 2,
        '2026-09-03': 1.5,
        '2026-09-04': -1,
        '2026-09-05': '4',
        '2026-09-06': 0,
        '2026-09-07 ': 2,
      }),
    })
    expect([...projectCommitDays(s, 'a')]).toEqual([
      ['2026-09-01', 3],
      ['2026-09-06', 0],
    ])
  })
  it('пустые случаи: нет статуса, проекта, репо, commitsByDay', () => {
    expect(projectCommitDays(null, 'a').size).toBe(0)
    expect(projectCommitDays(status({}), 'a').size).toBe(0)
    expect(projectCommitDays(status({ a: {} }), 'a').size).toBe(0)
    expect(projectCommitDays(status({ a: repo('o/a') }), 'a').size).toBe(0)
    expect(projectCommitDays(status({}), '__proto__').size).toBe(0)
  })
})

describe('commitDays', () => {
  it('суммирует по дням разные репо', () => {
    const s = status({
      a: repo('o/a', { '2026-09-01': 2, '2026-09-02': 1 }),
      b: repo('o/b', { '2026-09-01': 5 }),
    })
    expect([...commitDays(s, ['a', 'b'])].sort()).toEqual([
      ['2026-09-01', 7],
      ['2026-09-02', 1],
    ])
  })
  it('общий репо у двух проектов считается один раз, регистр не важен', () => {
    const s = status({
      a: repo('Owner/Repo', { '2026-09-01': 2 }),
      b: repo('owner/repo', { '2026-09-01': 2 }),
    })
    expect(commitDays(s, ['a', 'b']).get('2026-09-01')).toBe(2)
  })
  it('пустые случаи', () => {
    expect(commitDays(null, ['a']).size).toBe(0)
    expect(commitDays(status({ a: repo('o/a', { '2026-09-01': 1 }) }), []).size).toBe(0)
    expect(commitDays(status({ a: {} }), ['a', 'нет']).size).toBe(0)
  })
})

describe('sumDays', () => {
  const days = new Map([
    ['2026-09-01', 1],
    ['2026-09-05', 2],
    ['2026-09-10', 4],
  ])
  it('границы включительно', () => {
    expect(sumDays(days, '2026-09-01', '2026-09-10')).toBe(7)
    expect(sumDays(days, '2026-09-05', '2026-09-05')).toBe(2)
    expect(sumDays(days, '2026-09-02', '2026-09-09')).toBe(2)
  })
  it('пусто и перевёрнутый отрезок', () => {
    expect(sumDays(new Map(), '2026-09-01', '2026-09-10')).toBe(0)
    expect(sumDays(days, '2026-09-10', '2026-09-01')).toBe(0)
  })
})

describe('недоверенный status.json', () => {
  it('commitsByDay не объект: строка, число, null, массив', () => {
    for (const bad of ['2026-09-01', 5, null, true, [3, 4]]) {
      expect(projectCommitDays(status({ a: repo('o/a', bad) }), 'a').size).toBe(0)
    }
  })
  it('NaN, Infinity, объект и null вместо числа пропускаются', () => {
    const s = status({ a: repo('o/a', { '2026-09-01': NaN, '2026-09-02': Infinity, '2026-09-03': {}, '2026-09-04': null, '2026-09-05': 1 }) })
    expect([...projectCommitDays(s, 'a')]).toEqual([['2026-09-05', 1]])
  })
  it('ключ с переводом строки или суффиксом не проходит', () => {
    const s = status({ a: repo('o/a', { '2026-09-01\n': 1, '2026-09-01T00': 1, '12026-09-01': 1 }) })
    expect(projectCommitDays(s, 'a').size).toBe(0)
  })
  it('fullName не строка или пустой: репо не схлопываются', () => {
    const s = status({
      a: { repo: { fullName: 5, commitsByDay: { '2026-09-01': 1 } } },
      b: { repo: { fullName: 5, commitsByDay: { '2026-09-01': 1 } } },
      c: { repo: { fullName: '', commitsByDay: { '2026-09-01': 1 } } },
      d: { repo: { commitsByDay: { '2026-09-01': 1 } } },
    })
    expect(commitDays(s, ['a', 'b', 'c', 'd']).get('2026-09-01')).toBe(4)
  })
  it('повторяющийся slug в списке не удваивает', () => {
    const s = status({ a: repo('o/a', { '2026-09-01': 2 }) })
    expect(commitDays(s, ['a', 'a']).get('2026-09-01')).toBe(2)
  })
  it('проект без репо не мешает остальным', () => {
    const s = status({ a: {}, b: repo('o/b', { '2026-09-01': 2 }) })
    expect(commitDays(s, ['a', 'b']).get('2026-09-01')).toBe(2)
  })
})
