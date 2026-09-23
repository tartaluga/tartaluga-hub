import { describe, expect, it } from 'vitest'
import { buildLibrary } from './projects'
import {
  abandoned,
  eyebrowDate,
  hotItems,
  hotWhen,
  localKey,
  nextSteps,
  pulse,
  pulseCaption,
  pulseLevel,
  statusShares,
  summary,
  type HotItem,
} from './today'

const TODAY = new Date(2026, 8, 23, 14, 32) // среда, 23.09.2026

let n = 0
function project(slug: string, extra: object = {}) {
  n++
  return {
    path: `projects/${slug}.json`,
    sha: `sha${n}`,
    text: JSON.stringify({
      schemaVersion: 1,
      slug,
      title: slug.toUpperCase(),
      status: 'active',
      createdAt: '2026-09-20T10:00:00+03:00',
      updatedAt: '2026-09-20T10:00:00+03:00',
      ...extra,
    }),
  }
}

const settings = (days: number) => ({ path: 'settings.json', sha: 's', text: JSON.stringify({ schemaVersion: 1, tags: [], abandonedAfterDays: days }) })
const id = (c: string) => '01J' + c.repeat(23)
const lib = (files: ReturnType<typeof project>[], today = TODAY) => buildLibrary(files, today).projects
const task = (c: string, due: string | undefined, done = false, milestoneId?: string) => ({ id: id(c), title: `t${c}`, done, due, milestoneId })
/** Местный момент в ISO со смещением — так тесты не зависят от пояса машины. */
function at(y: number, m: number, d: number, h = 12, min = 0): string {
  const t = new Date(y, m - 1, d, h, min)
  const off = -t.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const p = (x: number) => String(Math.floor(Math.abs(x))).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}T${p(h)}:${p(min)}:00${sign}${p(off / 60)}:${p(off % 60)}`
}
const log = (c: string, when: string) => ({ id: id(c), at: when, kind: 'done', text: 'x' })

describe('hotItems', () => {
  it('граница 3 дней: +3 входит, +4 нет; сегодня и просрочка входят', () => {
    const items = hotItems(
      lib([project('a', { tasks: [task('A', '2026-09-26'), task('B', '2026-09-27'), task('C', '2026-09-23'), task('D', '2026-09-01')] })]),
      TODAY,
    )
    expect(items.map((i) => [i.title, i.days])).toEqual([
      ['tD', -22],
      ['tC', 0],
      ['tA', 3],
    ])
  })

  it('знак просрочки: вчера — −1, завтра — +1, независимо от часа «сегодня»', () => {
    const late = new Date(2026, 8, 23, 23, 59)
    const early = new Date(2026, 8, 23, 0, 1)
    const files = [project('a', { tasks: [task('A', '2026-09-22'), task('B', '2026-09-24')] })]
    for (const today of [late, early]) {
      expect(hotItems(lib(files, today), today).map((i) => i.days)).toEqual([-1, 1])
    }
  })

  it('дата срока — местная: полночь по UTC её не сдвигает', () => {
    // 2026-09-24 как new Date('2026-09-24') был бы полночью UTC и в западных поясах дал бы 23-е.
    const items = hotItems(lib([project('a', { tasks: [task('A', '2026-09-24')] })]), TODAY)
    expect(items[0]).toMatchObject({ due: '2026-09-24', days: 1 })
  })

  it('сделанные задачи и задачи без срока не горят', () => {
    const items = hotItems(lib([project('a', { tasks: [task('A', '2026-09-22', true), task('B', undefined)] })]), TODAY)
    expect(items).toEqual([])
  })

  it('веха горит, пока у неё нет задач или есть открытая; закрытая веха — нет', () => {
    const m = (c: string) => ({ id: id(c), title: `m${c}`, due: '2026-09-24' })
    const items = hotItems(
      lib([
        project('a', {
          milestones: [m('M'), m('N'), m('P')],
          tasks: [task('A', undefined, true, id('N')), task('B', undefined, false, id('P')), task('C', undefined, true, id('P'))],
        }),
      ]),
      TODAY,
    )
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ['milestone', 'mM'],
      ['milestone', 'mP'],
    ])
  })

  it('задача и веха различаются по kind и несут проект', () => {
    const items = hotItems(
      lib([project('a', { milestones: [{ id: id('M'), title: 'веха', due: '2026-09-25' }], tasks: [task('A', '2026-09-25')] })]),
      TODAY,
    )
    expect(items.map((i) => i.kind).sort()).toEqual(['milestone', 'task'])
    expect(items.every((i) => i.slug === 'a' && i.project === 'A')).toBe(true)
  })

  it('горят только проекты в работе: идея, пауза, готово и архив — нет', () => {
    const items = hotItems(
      lib([
        project('a', { status: 'archived', tasks: [task('A', '2026-09-22')] }),
        project('b', { status: 'paused', tasks: [task('B', '2026-09-22')] }),
        project('c', { status: 'done', tasks: [task('C', '2026-09-22')] }),
        project('d', { status: 'idea', milestones: [{ id: id('D'), title: 'm', due: '2026-09-22' }] }),
        project('e', { tasks: [task('E', '2026-09-22')] }),
      ]),
      TODAY,
    )
    expect(items.map((i) => i.slug)).toEqual(['e'])
  })

  it('сортировка по сроку, потом по проекту и названию', () => {
    const items = hotItems(
      lib([
        project('b', { tasks: [task('A', '2026-09-24'), task('B', '2026-09-22')] }),
        project('a', { tasks: [task('C', '2026-09-24')] }),
      ]),
      TODAY,
    )
    expect(items.map((i) => `${i.slug}${i.title}`)).toEqual(['btB', 'atC', 'btA'])
  })
})

describe('hotWhen', () => {
  it('просрочка с минусом и датой, сегодня, завтра, дальше — дата и день недели', () => {
    expect(hotWhen({ due: '2026-09-21', days: -2 })).toBe('−2 дн · 21.09')
    expect(hotWhen({ due: '2026-09-23', days: 0 })).toBe('сегодня')
    expect(hotWhen({ due: '2026-09-24', days: 1 })).toBe('завтра')
    expect(hotWhen({ due: '2026-09-26', days: 3 })).toBe('26.09 · сб')
    expect(hotWhen({ due: '2026-09-25', days: 2 })).toBe('25.09 · пт')
  })
})

describe('nextSteps и abandoned', () => {
  it('следующие шаги — только в работе, с непустым шагом, свежие сверху', () => {
    const ps = lib([
      project('old', { nextStep: 'шаг', log: [log('A', at(2026, 9, 1))] }),
      project('new', { nextStep: 'шаг', log: [log('B', at(2026, 9, 22))] }),
      project('blank', { nextStep: '   ' }),
      project('none'),
      project('paused', { status: 'paused', nextStep: 'шаг' }),
      project('arch', { status: 'archived', nextStep: 'шаг' }),
    ])
    expect(nextSteps(ps).map((p) => p.data.slug)).toEqual(['new', 'old'])
  })

  it('заброшенные — в работе и тише порога из settings.json, самые тихие сверху', () => {
    const ps = buildLibrary(
      [
        settings(5),
        project('quiet', { log: [log('A', at(2026, 9, 10))] }),
        project('quieter', { log: [log('B', at(2026, 9, 1))] }),
        project('edge', { log: [log('C', at(2026, 9, 18))] }),
        project('fresh', { log: [log('D', at(2026, 9, 22))] }),
        project('arch', { status: 'archived', log: [log('E', at(2026, 8, 1))] }),
        project('paused', { status: 'paused', log: [log('F', at(2026, 8, 1))] }),
      ],
      TODAY,
    ).projects
    expect(abandoned(ps).map((p) => [p.data.slug, p.silentDays])).toEqual([
      ['quieter', 22],
      ['quiet', 13],
    ])
    expect(abandoned(ps, false).map((p) => p.data.slug)).toEqual(['quiet', 'quieter'])
  })
})

describe('pulse', () => {
  it('12 недель по 7 дней, первая неделя с понедельника, последняя содержит сегодня', () => {
    const p = pulse([], TODAY)
    expect(p.weeks).toHaveLength(12)
    expect(p.weeks.every((w) => w.length === 7)).toBe(true)
    const first = p.weeks[0]![0]!.date
    expect(first).toBe('2026-07-06')
    const [y, m, d] = first.split('-').map(Number) as [number, number, number]
    expect(new Date(y, m - 1, d).getDay()).toBe(1)
    const last = p.weeks[11]!
    expect(last.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'])
    expect(last.map((d) => d.future)).toEqual([false, false, false, true, true, true, true])
  })

  it('в понедельник и воскресенье текущая неделя всё равно последняя', () => {
    const mon = pulse([], new Date(2026, 8, 21, 9))
    expect(mon.weeks[11]![0]!.date).toBe('2026-09-21')
    expect(mon.weeks[11]!.filter((d) => !d.future)).toHaveLength(1)
    const sun = pulse([], new Date(2026, 8, 27, 23, 30))
    expect(sun.weeks[11]![6]!).toMatchObject({ date: '2026-09-27', future: false })
  })

  it('дни идут подряд без пропусков и повторов через переход на зимнее время', () => {
    const p = pulse([], new Date(2026, 10, 10))
    const dates = p.weeks.flat().map((d) => d.date)
    expect(new Set(dates).size).toBe(84)
    for (let i = 1; i < dates.length; i++) {
      const [a, b] = [dates[i - 1]!, dates[i]!].map((s) => new Date(s + 'T12:00:00Z').getTime())
      expect(b! - a!).toBe(24 * 60 * 60 * 1000)
    }
  })

  it('записи раскладываются по местным дням, считаются все статусы, будущее и старое не попадают', () => {
    const ps = lib([
      project('a', { log: [log('A', at(2026, 9, 23, 0, 5)), log('B', at(2026, 9, 23, 23, 55)), log('C', at(2026, 9, 22))] }),
      project('b', { status: 'archived', log: [log('D', at(2026, 9, 22)), log('E', at(2026, 1, 1))] }),
    ])
    const p = pulse(ps, TODAY)
    const byDate = Object.fromEntries(p.weeks.flat().map((d) => [d.date, d]))
    expect(byDate['2026-09-23']!.count).toBe(2)
    expect(byDate['2026-09-22']!.count).toBe(2)
    expect(p.max).toBe(2)
    expect(p.weeks.flat().reduce((s, d) => s + d.count, 0)).toBe(4)
  })

  it('записи из будущего (часы в другом поясе, ошибка) в клетки не попадают', () => {
    const p = pulse(lib([project('a', { log: [log('A', at(2026, 9, 25))] })]), TODAY)
    expect(p.weeks.flat().every((d) => d.count === 0)).toBe(true)
    expect(p.max).toBe(0)
  })

  it('записи за месяц — только текущий календарный месяц', () => {
    const ps = lib([project('a', { log: [log('A', at(2026, 9, 1, 0, 1)), log('B', at(2026, 9, 23)), log('C', at(2026, 8, 31, 23, 59)), log('D', at(2025, 9, 10))] })])
    expect(pulse(ps, TODAY).monthCount).toBe(2)
  })

  it('уровни: 0 — пусто, остальное по четвертям от максимума, минимум 1', () => {
    expect(pulseLevel(0, 10)).toBe(0)
    expect(pulseLevel(1, 10)).toBe(1)
    expect(pulseLevel(3, 10)).toBe(2)
    expect(pulseLevel(5, 10)).toBe(2)
    expect(pulseLevel(6, 10)).toBe(3)
    expect(pulseLevel(10, 10)).toBe(4)
    expect(pulseLevel(0, 0)).toBe(0)
  })

  it('подпись: склонение и месяц', () => {
    expect(pulseCaption(31, TODAY)).toBe('31 запись за сентябрь')
    expect(pulseCaption(2, TODAY)).toBe('2 записи за сентябрь')
    expect(pulseCaption(11, TODAY)).toBe('11 записей за сентябрь')
    expect(pulseCaption(0, new Date(2026, 0, 5))).toBe('За январь записей в логе нет')
  })

  it('localKey — местная дата', () => {
    expect(localKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})

describe('statusShares', () => {
  it('все статусы по порядку, архив считается, доли в сумме 1', () => {
    const ps = lib([project('a'), project('b'), project('c', { status: 'archived' }), project('d', { status: 'idea' })])
    const s = statusShares(ps)
    expect(s.map((x) => [x.status, x.count])).toEqual([
      ['idea', 1],
      ['active', 2],
      ['paused', 0],
      ['done', 0],
      ['archived', 1],
    ])
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1)
  })

  it('без проектов — нули, не NaN', () => {
    expect(statusShares([]).every((x) => x.count === 0 && x.share === 0)).toBe(true)
  })
})

describe('шапка', () => {
  it('дата и время в надзаголовке', () => {
    expect(eyebrowDate(TODAY)).toBe('ср · 23.09.2026 · 14:32')
    expect(eyebrowDate(new Date(2026, 0, 4, 9, 5))).toBe('вс · 04.01.2026 · 09:05')
  })

  const hot = (days: number[]) => days.map((d) => ({ days: d }) as HotItem)

  it('сводка со склонениями', () => {
    expect(summary(hot([-2, 0, 1, 3]), 2, 12)).toBe('4 дедлайна, 1 просрочен · 2 проекта без активности')
    expect(summary(hot([-1, -1, 0, 0, 0]), 1, 3)).toBe('5 дедлайнов, 2 просрочено · 1 проект без активности')
    expect(summary(hot([1]), 0, 3)).toBe('1 дедлайн')
    expect(summary([], 5, 9)).toBe('Горящих сроков нет · 5 проектов без активности')
    expect(summary([], 0, 0)).toBe('Проектов пока нет')
  })
})
