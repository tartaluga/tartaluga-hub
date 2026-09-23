import { describe, expect, it } from 'vitest'
import {
  activityText,
  applyFilter,
  buildLibrary,
  countByStatus,
  daysUntil,
  deadlineText,
  EMPTY_FILTER,
  filterFromParams,
  filterToParams,
  isHot,
  type Filter,
} from './projects'
import { coverSpec } from '../components/Cover'
import { plural } from '../lib/plural'

const TODAY = new Date(2026, 8, 23, 15, 0) // 23.09.2026, день

let n = 0
function project(slug: string, extra: object = {}) {
  n++
  return {
    path: `projects/${slug}.json`,
    sha: `sha${n}`,
    text: JSON.stringify({
      schemaVersion: 1,
      slug,
      title: slug,
      status: 'active',
      createdAt: '2026-09-01T10:00:00+03:00',
      updatedAt: '2026-09-01T10:00:00+03:00',
      ...extra,
    }),
  }
}

const settings = (tags: object[]) => ({ path: 'settings.json', sha: 's', text: JSON.stringify({ schemaVersion: 1, tags }) })
const id = (c: string) => '01J' + c.repeat(23)
const f = (over: Partial<Filter>) => ({ ...EMPTY_FILTER, ...over })

describe('buildLibrary', () => {
  it('прогресс — доля закрытых задач; без задач — null', () => {
    const lib = buildLibrary(
      [
        project('a', {
          tasks: [
            { id: id('A'), title: '1', done: true },
            { id: id('B'), title: '2', done: false },
            { id: id('C'), title: '3', done: true },
            { id: id('D'), title: '4', done: false },
          ],
        }),
        project('b'),
      ],
      TODAY,
    )
    const bySlug = Object.fromEntries(lib.projects.map((p) => [p.data.slug, p]))
    expect(bySlug.a).toMatchObject({ progress: 0.5, tasksDone: 2, tasksTotal: 4 })
    expect(bySlug.b!.progress).toBeNull()
  })

  it('срок — ближайший среди открытых задач и незакрытых вех; сделанное не считается', () => {
    const lib = buildLibrary(
      [
        project('a', {
          milestones: [
            { id: id('M'), title: 'Веха закрыта', due: '2026-09-20' },
            { id: id('N'), title: 'Веха в работе', due: '2026-09-25' },
            { id: id('P'), title: 'Веха без задач', due: '2026-10-01' },
          ],
          tasks: [
            { id: id('A'), title: 'сделано давно', done: true, due: '2026-09-01' },
            { id: id('B'), title: 'в закрытой вехе', done: true, milestoneId: id('M') },
            { id: id('C'), title: 'открыта', done: false, milestoneId: id('N'), due: '2026-09-28' },
          ],
        }),
      ],
      TODAY,
    )
    expect(lib.projects[0]!.deadline).toEqual({ due: '2026-09-25', title: 'Веха в работе', days: 2 })
  })

  it('битый файл не валит остальные и попадает в список проблем', () => {
    const lib = buildLibrary([project('a'), { path: 'projects/b.json', sha: 'x', text: '{' }, project('c', { status: 'wip' })], TODAY)
    expect(lib.projects.map((p) => p.data.slug)).toEqual(['a'])
    expect(lib.broken.map((b) => b.path)).toEqual(['projects/b.json', 'projects/c.json'])
  })

  it('теги берутся из settings.json; без него — понятная причина', () => {
    const tags = [{ id: 'dnd', name: 'ДнД', color: '#d472b2' }]
    expect(buildLibrary([settings(tags)], TODAY)).toMatchObject({ tags, settingsProblem: null })
    expect(buildLibrary([], TODAY).settingsProblem).toMatch(/settings\.json/)
    expect(buildLibrary([{ path: 'settings.json', sha: 's', text: '[]' }], TODAY).settingsProblem).toMatch(/не читается/)
  })

  it('файл новой версии формата показывается, но помечен «только чтение»', () => {
    const lib = buildLibrary([project('a', { schemaVersion: 2 })], TODAY)
    expect(lib.projects[0]!.readOnly).toBe(true)
  })
})

describe('applyFilter', () => {
  const lib = buildLibrary(
    [
      project('alpha', { title: 'Бот расписания', tags: ['code'], nextStep: 'Починить парсер', updatedAt: '2026-09-20T10:00:00+03:00' }),
      project('beta', { title: 'Ёлка', status: 'paused', tags: ['dnd'], stack: ['Godot'], updatedAt: '2026-09-22T10:00:00+03:00' }),
      project('gamma', { title: 'Архивный', status: 'archived', tags: ['code'], updatedAt: '2026-09-23T10:00:00+03:00' }),
      project('delta', { title: 'Диплом', status: 'idea', tags: ['code', 'study'], updatedAt: '2026-09-10T10:00:00+03:00' }),
    ],
    TODAY,
  )
  const slugs = (filter: Filter) => applyFilter(lib.projects, filter).map((p) => p.data.slug)

  it('архив по умолчанию скрыт, выбранный статус «архив» его показывает', () => {
    expect(slugs(EMPTY_FILTER)).not.toContain('gamma')
    expect(slugs(f({ statuses: ['archived'] }))).toEqual(['gamma'])
  })

  it('по умолчанию — недавно изменённые сверху', () => {
    expect(slugs(EMPTY_FILTER)).toEqual(['beta', 'alpha', 'delta'])
  })

  it('поиск по названию, шагу и стеку, без учёта регистра и ё/е', () => {
    expect(slugs(f({ query: 'ПАРСЕР' }))).toEqual(['alpha'])
    expect(slugs(f({ query: 'елка' }))).toEqual(['beta'])
    expect(slugs(f({ query: 'godot' }))).toEqual(['beta'])
    expect(slugs(f({ query: 'бот парсер' }))).toEqual(['alpha'])
    expect(slugs(f({ query: 'бот godot' }))).toEqual([])
  })

  it('теги — любой из выбранных; статус, теги и поиск складываются', () => {
    expect(slugs(f({ tags: ['dnd', 'study'] }))).toEqual(['beta', 'delta'])
    expect(slugs(f({ tags: ['code'], statuses: ['idea', 'archived'] }))).toEqual(['gamma', 'delta'])
    expect(slugs(f({ tags: ['code'], statuses: ['idea', 'archived'], query: 'диплом' }))).toEqual(['delta'])
  })

  it('сортировка по названию — по-русски', () => {
    expect(slugs(f({ sort: 'title' }))).toEqual(['alpha', 'delta', 'beta'])
  })
})

describe('активность и тишина (макет 2a)', () => {
  const log = (at: string, c: string) => ({ id: id(c), at, kind: 'done', text: 'x' })

  it('активность — последняя запись лога, без лога — последняя правка файла', () => {
    const lib = buildLibrary(
      [
        project('a', { log: [log('2026-09-20T10:00:00+03:00', 'A'), log('2026-09-22T23:00:00+03:00', 'B')], updatedAt: '2026-09-23T09:00:00+03:00' }),
        project('b', { updatedAt: '2026-09-23T09:00:00+03:00' }),
      ],
      TODAY,
    )
    const by = Object.fromEntries(lib.projects.map((p) => [p.data.slug, p]))
    expect(by.a!.activityDays).toBe(1)
    expect(by.b!.activityDays).toBe(0)
    expect([activityText(0), activityText(1), activityText(4)]).toEqual(['сегодня', 'вчера', '4 дн'])
  })

  it('«N дн тишины» — только у проекта в работе, дольше порога из settings.json', () => {
    const files = [
      project('quiet', { log: [log('2026-09-01T10:00:00+03:00', 'A')] }),
      project('paused', { status: 'paused', log: [log('2026-09-01T10:00:00+03:00', 'B')] }),
      project('fresh', { log: [log('2026-09-15T10:00:00+03:00', 'C')] }),
      project('nolog', { createdAt: '2026-08-01T10:00:00+03:00' }),
    ]
    const by = (lib: ReturnType<typeof buildLibrary>) => Object.fromEntries(lib.projects.map((p) => [p.data.slug, p.silentDays]))
    expect(by(buildLibrary(files, TODAY))).toEqual({ quiet: 22, paused: null, fresh: null, nolog: 53 })
    // settings.json может лежать в кэше после проектов — порог всё равно берётся из него.
    expect(by(buildLibrary([...files, settings([])].reverse(), TODAY)).fresh).toBeNull()
    const strict = { path: 'settings.json', sha: 's', text: JSON.stringify({ schemaVersion: 1, tags: [], abandonedAfterDays: 7 }) }
    expect(by(buildLibrary([...files, strict], TODAY)).fresh).toBe(8)
  })

  it('ровно порог — ещё не тишина («дольше N дней»)', () => {
    const lib = buildLibrary([project('edge', { log: [log('2026-09-09T10:00:00+03:00', 'A')] }), project('over', { log: [log('2026-09-08T10:00:00+03:00', 'B')] })], TODAY)
    expect(lib.projects.map((p) => p.silentDays)).toEqual([null, 15])
  })

  it('сортировка по активности учитывает лог, а не только правку файла', () => {
    const lib = buildLibrary(
      [
        project('edited', { updatedAt: '2026-09-22T10:00:00+03:00' }),
        project('logged', { updatedAt: '2026-09-01T10:00:00+03:00', log: [log('2026-09-23T08:00:00+03:00', 'A')] }),
      ],
      TODAY,
    )
    expect(applyFilter(lib.projects, EMPTY_FILTER).map((p) => p.data.slug)).toEqual(['logged', 'edited'])
  })

  it('счётчики по статусам', () => {
    const lib = buildLibrary([project('a'), project('b', { status: 'idea' }), project('c', { status: 'archived' }), project('d')], TODAY)
    expect(countByStatus(lib.projects)).toEqual({ idea: 1, active: 2, paused: 0, done: 0, archived: 1 })
  })
})

describe('сортировка по сроку и прогрессу', () => {
  const lib = buildLibrary(
    [
      project('late', { tasks: [{ id: id('A'), title: 't', done: false, due: '2026-10-10' }] }),
      project('none'),
      project('soon', {
        tasks: [
          { id: id('B'), title: 't', done: false, due: '2026-09-24' },
          { id: id('C'), title: 't', done: true },
        ],
      }),
    ],
    TODAY,
  )
  const slugs = (sort: Filter['sort']) => applyFilter(lib.projects, f({ sort })).map((p) => p.data.slug)

  it('без срока и без задач — в конце', () => {
    expect(slugs('deadline')).toEqual(['soon', 'late', 'none'])
    expect(slugs('progress')).toEqual(['soon', 'late', 'none'])
  })
})

describe('фильтр в адресе', () => {
  it('туда и обратно без потерь', () => {
    const filter: Filter = { query: 'бот', statuses: ['idea', 'archived'], tags: ['code'], sort: 'deadline' }
    expect(filterFromParams(filterToParams(filter))).toEqual(filter)
  })

  it('пустой фильтр — пустой адрес; мусор в адресе игнорируется', () => {
    expect(filterToParams(EMPTY_FILTER).toString()).toBe('')
    expect(filterFromParams(new URLSearchParams('status=wip&status=done&sort=evil'))).toEqual(f({ statuses: ['done'] }))
  })
})

describe('сроки', () => {
  it('считаются в календарных днях по местному времени', () => {
    expect(daysUntil('2026-09-23', TODAY)).toBe(0)
    expect(daysUntil('2026-09-24', new Date(2026, 8, 23, 23, 59))).toBe(1)
    expect(daysUntil('2026-09-21', TODAY)).toBe(-2)
    expect(daysUntil('2026-10-26', TODAY)).toBe(33) // через переход на зимнее время там, где он есть
  })

  it('подписи и «горит»', () => {
    expect(deadlineText({ due: '2026-09-21', days: -2 })).toBe('−2 дн · 21.09')
    expect(deadlineText({ due: '2026-09-23', days: 0 })).toBe('сегодня')
    expect(deadlineText({ due: '2026-09-24', days: 1 })).toBe('завтра')
    expect(deadlineText({ due: '2026-09-26', days: 3 })).toBe('26.09')
    expect([isHot({ days: -5 }), isHot({ days: 3 }), isHot({ days: 4 })]).toEqual([true, true, false])
  })
})

describe('обложка-заглушка', () => {
  it('одна и та же для slug и разная для разных slug', () => {
    expect(coverSpec('tartaluga-hub')).toEqual(coverSpec('tartaluga-hub'))
    const specs = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => JSON.stringify(coverSpec(s))))
    expect(specs.size).toBeGreaterThan(4)
  })
})

describe('plural', () => {
  it.each([
    [1, 'проект'],
    [2, 'проекта'],
    [5, 'проектов'],
    [11, 'проектов'],
    [12, 'проектов'],
    [21, 'проект'],
    [22, 'проекта'],
    [0, 'проектов'],
  ])('%i %s', (num, word) => expect(plural(num, 'проект', 'проекта', 'проектов')).toBe(word))
})
