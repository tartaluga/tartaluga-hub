import { describe, expect, it } from 'vitest'
import { equal, merge, MergeRefused, type JsonObject } from './merge'

const A = '01K5Z0000000000000000000AA'
const B = '01K5Z0000000000000000000BB'
const C = '01K5Z0000000000000000000CC'
const D = '01K5Z0000000000000000000DD'

const base: JsonObject = {
  schemaVersion: 1,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  nextStep: 'Починить парсер',
  tags: ['tg'],
  tasks: [
    { id: A, title: 'Первая', done: false },
    { id: B, title: 'Вторая', done: false },
  ],
  futureField: { keep: true },
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}

const T = base.tasks as JsonObject[]

/** Копия базы с правками поверх (undefined — удалить поле). */
function edit(patch: Record<string, unknown>, from: JsonObject = base): JsonObject {
  const out = structuredClone(from) as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out as JsonObject
}

describe('скалярные поля', () => {
  it('изменение с одной стороны принимается — и с моей, и с удалённой', () => {
    const r = merge(base, edit({ title: 'Бот 2' }), edit({ nextStep: 'Выкатить' }))
    expect(r.conflicts).toEqual([])
    expect(r.merged.title).toBe('Бот 2')
    expect(r.merged.nextStep).toBe('Выкатить')
  })

  it('одинаковая правка с двух сторон — не конфликт', () => {
    const r = merge(base, edit({ status: 'done', title: 'Бот 🤖' }), edit({ status: 'done', title: 'Бот 🤖' }))
    expect(r.conflicts).toEqual([])
    expect(r.merged).toMatchObject({ status: 'done', title: 'Бот 🤖' })
  })

  it('разные правки одного поля — конфликт с тремя значениями, в результате удалённое', () => {
    const r = merge(base, edit({ title: 'Бот на Rust 🦀' }), edit({ title: 'Бот-ёжик' }))
    expect(r.conflicts).toEqual([{ kind: 'field', path: ['title'], base: 'Бот', local: 'Бот на Rust 🦀', remote: 'Бот-ёжик' }])
    expect(r.merged.title).toBe('Бот-ёжик')
  })

  it('удаление поля с одной стороны принимается', () => {
    const r = merge(base, edit({ nextStep: undefined }), edit({ title: 'Бот 2' }))
    expect(r.conflicts).toEqual([])
    expect('nextStep' in r.merged).toBe(false)
    expect(r.merged.title).toBe('Бот 2')
  })

  it('удаление поля против его правки — конфликт, undefined обозначает «поля нет»', () => {
    const r = merge(base, edit({ nextStep: 'Новый шаг' }), edit({ nextStep: undefined }))
    expect(r.conflicts).toEqual([{ kind: 'field', path: ['nextStep'], base: 'Починить парсер', local: 'Новый шаг', remote: undefined }])
    expect('nextStep' in r.merged).toBe(false)
  })

  it('новое поле с одной стороны добавляется; с двух по-разному — конфликт с base undefined', () => {
    const r = merge(base, edit({ cover: 'covers/bot.webp', description: 'а' }), edit({ description: 'б' }))
    expect(r.merged.cover).toBe('covers/bot.webp')
    expect(r.conflicts).toEqual([{ kind: 'field', path: ['description'], base: undefined, local: 'а', remote: 'б' }])
  })

  it('null — значение, а не отсутствие поля', () => {
    const withCover = edit({ cover: 'covers/bot.webp' })
    const r = merge(withCover, edit({ cover: null }, withCover), withCover)
    expect(r.conflicts).toEqual([])
    expect(r.merged.cover).toBeNull()
  })

  it('поле null в базе удалено с одной стороны, не менялось с другой — удаление принимается без конфликта', () => {
    const withNullCover = edit({ cover: null })
    const r = merge(withNullCover, edit({ cover: undefined }, withNullCover), withNullCover)
    expect(r.conflicts).toEqual([])
    expect('cover' in r.merged).toBe(false)
  })

  it('поле удалено с обеих сторон независимо — просто отсутствует, без конфликта', () => {
    const withCover = edit({ cover: 'covers/bot.webp' })
    const r = merge(withCover, edit({ cover: undefined }, withCover), edit({ cover: undefined, title: 'Бот 2' }, withCover))
    expect(r.conflicts).toEqual([])
    expect('cover' in r.merged).toBe(false)
    expect(r.merged.title).toBe('Бот 2')
  })

  it('массивы без id (теги, стек) и вложенные объекты сливаются как скаляры', () => {
    const one = merge(base, edit({ tags: ['tg', 'rust'] }), edit({ futureField: { keep: false } }))
    expect(one.conflicts).toEqual([])
    expect(one.merged).toMatchObject({ tags: ['tg', 'rust'], futureField: { keep: false } })

    const two = merge(base, edit({ tags: ['tg', 'rust'] }), edit({ tags: ['tg', 'go'] }))
    expect(two.conflicts).toEqual([{ kind: 'field', path: ['tags'], base: ['tg'], local: ['tg', 'rust'], remote: ['tg', 'go'] }])
  })
})

describe('служебные метки времени', () => {
  it('updatedAt с обеих сторон — берётся более позднее по моменту, а не по строке', () => {
    // 12:30+03:00 = 09:30Z позже, чем 13:00+05:00 = 08:00Z, хотя строка «меньше».
    const r = merge(base, edit({ title: 'Бот 2', updatedAt: '2026-09-02T12:30:00+03:00' }), edit({ nextStep: 'x', updatedAt: '2026-09-02T13:00:00+05:00' }))
    expect(r.conflicts).toEqual([])
    expect(r.merged.updatedAt).toBe('2026-09-02T12:30:00+03:00')

    const back = merge(base, edit({ updatedAt: '2026-09-02T13:00:00+05:00' }), edit({ updatedAt: '2026-09-02T12:30:00+03:00' }))
    expect(back.merged.updatedAt).toBe('2026-09-02T12:30:00+03:00')
  })

  it('doneAt у задачи тоже служебная метка', () => {
    const doneL = edit({ tasks: [{ id: A, title: 'Первая', done: true, doneAt: '2026-09-02T10:00:00+03:00' }, { id: B, title: 'Вторая', done: false }] })
    const doneR = edit({ tasks: [{ id: A, title: 'Первая', done: true, doneAt: '2026-09-02T11:00:00+03:00' }, { id: B, title: 'Вторая', done: false }] })
    const r = merge(base, doneL, doneR)
    expect(r.conflicts).toEqual([])
    expect((r.merged.tasks as JsonObject[])[0]!.doneAt).toBe('2026-09-02T11:00:00+03:00')
  })

  it('метка удалена с одной стороны и изменена с другой — обычный конфликт поля', () => {
    const r = merge(base, edit({ updatedAt: undefined }), edit({ updatedAt: '2026-09-03T10:00:00+03:00' }))
    expect(r.conflicts.map((c) => c.path)).toEqual([['updatedAt']])
  })

  it('неразбираемая метка не выигрывает молча — конфликт', () => {
    const r = merge(base, edit({ updatedAt: 'вчера' }), edit({ updatedAt: '2026-09-03T10:00:00+03:00' }))
    expect(r.conflicts.map((c) => c.path)).toEqual([['updatedAt']])
  })

  it('метка изменена с одной стороны — берётся она, даже если она раньше базы', () => {
    const r = merge(base, edit({ updatedAt: '2026-08-01T10:00:00+03:00' }), base)
    expect(r.merged.updatedAt).toBe('2026-08-01T10:00:00+03:00')
  })

  it('один и тот же момент в разных часовых поясах с двух сторон — не конфликт, строки разные', () => {
    // 12:00+03:00 и 09:00Z — один и тот же момент, но разные строки: equal(local, remote) не сработает,
    // нужна ветка через Date.parse.
    const r = merge(
      base,
      edit({ title: 'Л', updatedAt: '2026-09-02T12:00:00+03:00' }),
      edit({ nextStep: 'x', updatedAt: '2026-09-02T09:00:00Z' }),
    )
    expect(r.conflicts).toEqual([])
    expect(['2026-09-02T12:00:00+03:00', '2026-09-02T09:00:00Z']).toContain(r.merged.updatedAt)
  })
})

describe('массивы с id', () => {
  const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, done: false, ...extra })

  it('добавления с обеих сторон сохраняются: удалённый порядок, мои новые в конец', () => {
    const r = merge(base, edit({ tasks: [task(C, 'Моя'), task(A, 'Первая'), task(B, 'Вторая')] }), edit({ tasks: [task(A, 'Первая'), task(B, 'Вторая'), task(D, 'С сервера')] }))
    expect(r.conflicts).toEqual([])
    expect((r.merged.tasks as JsonObject[]).map((t) => t.id)).toEqual([A, B, D, C])
  })

  it('удалено с одной стороны и не менялось с другой — удаляем (с обеих сторон)', () => {
    const r1 = merge(base, edit({ tasks: [task(B, 'Вторая')] }), base)
    expect(r1.conflicts).toEqual([])
    expect((r1.merged.tasks as JsonObject[]).map((t) => t.id)).toEqual([B])

    const r2 = merge(base, base, edit({ tasks: [task(A, 'Первая')] }))
    expect(r2.conflicts).toEqual([])
    expect((r2.merged.tasks as JsonObject[]).map((t) => t.id)).toEqual([A])
  })

  it('удалено с обеих сторон — удаляем без конфликта', () => {
    const r = merge(base, edit({ tasks: [task(B, 'Вторая')] }), edit({ tasks: [task(B, 'Вторая', { done: true })] }))
    expect(r.conflicts).toEqual([])
    expect(r.merged.tasks).toEqual([task(B, 'Вторая', { done: true })])
  })

  it('удалено у меня, изменено на сервере — конфликт элемента, элемент остаётся изменённым', () => {
    const r = merge(base, edit({ tasks: [task(B, 'Вторая')] }), edit({ tasks: [task(A, 'Первая!'), task(B, 'Вторая')] }))
    expect(r.conflicts).toEqual([{ kind: 'element', path: ['tasks', A], deletedBy: 'local', base: task(A, 'Первая'), local: undefined, remote: task(A, 'Первая!') }])
    expect(r.merged.tasks).toEqual([task(A, 'Первая!'), task(B, 'Вторая')])
  })

  it('удалено на сервере, изменено у меня — конфликт элемента, элемент возвращается в конец', () => {
    const r = merge(base, edit({ tasks: [task(A, 'Первая', { done: true }), task(B, 'Вторая')] }), edit({ tasks: [task(B, 'Вторая'), task(C, 'Третья')] }))
    expect(r.conflicts).toEqual([{ kind: 'element', path: ['tasks', A], deletedBy: 'remote', base: task(A, 'Первая'), local: task(A, 'Первая', { done: true }), remote: undefined }])
    expect((r.merged.tasks as JsonObject[]).map((t) => t.id)).toEqual([B, C, A])
  })

  it('разные поля одного элемента с двух сторон сливаются; одно поле по-разному — конфликт по пути с id', () => {
    const r = merge(
      base,
      edit({ tasks: [task(A, 'Первая', { done: true }), task(B, 'Вторая Л')] }),
      edit({ tasks: [task(A, 'Первая', { due: '2026-10-01' }), task(B, 'Вторая С')] }),
    )
    expect(r.merged.tasks).toEqual([task(A, 'Первая', { done: true, due: '2026-10-01' }), task(B, 'Вторая С')])
    expect(r.conflicts).toEqual([{ kind: 'field', path: ['tasks', B, 'title'], base: 'Вторая', local: 'Вторая Л', remote: 'Вторая С' }])
  })

  it('один id добавлен с обеих сторон (повтор создания) — поля сливаются, одинаковое не конфликтует', () => {
    const same = task(C, 'Новая')
    const r = merge(base, edit({ tasks: [...T, same] }), edit({ tasks: [...T, same] }))
    expect(r.conflicts).toEqual([])
    const diff = merge(base, edit({ tasks: [...T, task(C, 'а')] }), edit({ tasks: [...T, task(C, 'б')] }))
    expect(diff.conflicts).toEqual([{ kind: 'field', path: ['tasks', C, 'title'], base: undefined, local: 'а', remote: 'б' }])
  })

  it('перестановка у меня теряется в пользу удалённого порядка (ADR: порядок удалённый)', () => {
    const r = merge(base, edit({ tasks: [task(B, 'Вторая'), task(A, 'Первая')] }), edit({ title: 'x' }))
    expect((r.merged.tasks as JsonObject[]).map((t) => t.id)).toEqual([A, B])
  })

  it('лог: одновременные записи с двух устройств обе остаются, кириллица и эмодзи не портятся', () => {
    const entry = (id: string, text: string) => ({ id, at: '2026-09-02T10:00:00+03:00', kind: 'note', text })
    const b = edit({ log: [entry(A, 'Старт 🚀')] })
    const r = merge(b, edit({ log: [entry(A, 'Старт 🚀'), entry(B, 'Телефон: 👍🏽 ёж')] }, b), edit({ log: [entry(A, 'Старт 🚀'), entry(C, 'ПК: 家族')] }, b))
    expect(r.conflicts).toEqual([])
    expect(r.merged.log).toEqual([entry(A, 'Старт 🚀'), entry(C, 'ПК: 家族'), entry(B, 'Телефон: 👍🏽 ёж')])
  })

  it('массив, где нет id или id повторяется, сливается как скаляр', () => {
    const noId = edit({ tasks: [{ title: 'без id', done: false }] })
    const r = merge(base, noId, edit({ tasks: [task(A, 'Первая')] }))
    expect(r.conflicts.map((c) => c.path)).toEqual([['tasks']])

    const dup = edit({ links: [{ id: A, kind: 'site', value: 'https://a' }, { id: A, kind: 'site', value: 'https://b' }] })
    const r2 = merge(base, dup, edit({ links: [{ id: B, kind: 'site', value: 'https://c' }] }))
    expect(r2.conflicts.map((c) => c.path)).toEqual([['links']])
  })

  it('часть элементов массива без id (смешанный массив) — тоже сливается как скаляр целиком', () => {
    const mixed = edit({ tasks: [task(A, 'Первая'), { title: 'без id', done: false }] })
    const remoteTasks = [task(A, 'Первая!'), task(B, 'Вторая')]
    const r = merge(base, mixed, edit({ tasks: remoteTasks }))
    expect(r.conflicts.map((c) => c.path)).toEqual([['tasks']])
    // Конфликт скаляра разрешается в пользу удалённого значения (как обычное поле).
    expect(r.merged.tasks).toEqual(remoteTasks)
  })

  it('id-массив удалён целиком (поле отсутствует) с одной стороны, изменён с другой — обычный конфликт поля, без падения', () => {
    const r = merge(base, edit({ tasks: undefined }), edit({ tasks: [task(A, 'Первая!'), task(B, 'Вторая')] }))
    expect(r.conflicts).toEqual([{ kind: 'field', path: ['tasks'], base: T, local: undefined, remote: [task(A, 'Первая!'), task(B, 'Вторая')] }])
    expect(r.merged.tasks).toEqual([task(A, 'Первая!'), task(B, 'Вторая')])
  })

  it('поле-массив появилось с обеих сторон при отсутствии в базе — объединяется по id', () => {
    const r = merge(base, edit({ milestones: [{ id: A, title: 'M1' }] }), edit({ milestones: [{ id: B, title: 'M2' }] }))
    expect(r.conflicts).toEqual([])
    expect(r.merged.milestones).toEqual([{ id: B, title: 'M2' }, { id: A, title: 'M1' }])
  })

  it('settings: теги по id-слагу, цвет с одной стороны, имя с другой', () => {
    const s: JsonObject = { schemaVersion: 1, abandonedAfterDays: 14, tags: [{ id: 'rust', name: 'Rust', color: '#aa0000' }] }
    const r = merge(
      s,
      { ...s, tags: [{ id: 'rust', name: 'Раст', color: '#aa0000' }, { id: 'go', name: 'Go', color: '#00aaff' }] },
      { ...s, abandonedAfterDays: 30, tags: [{ id: 'rust', name: 'Rust', color: '#ff0000' }] },
    )
    expect(r.conflicts).toEqual([])
    expect(r.merged).toEqual({ schemaVersion: 1, abandonedAfterDays: 30, tags: [{ id: 'rust', name: 'Раст', color: '#ff0000' }, { id: 'go', name: 'Go', color: '#00aaff' }] })
  })
})

describe('незнакомые поля (ADR-003)', () => {
  it('сохраняются с обеих сторон и сливаются как скаляры', () => {
    const r = merge(base, edit({ skillNote: 'от скилла' }), edit({ widgetV2: { size: 'L' } }))
    expect(r.conflicts).toEqual([])
    expect(r.merged).toMatchObject({ skillNote: 'от скилла', widgetV2: { size: 'L' }, futureField: { keep: true } })
  })

  it('незнакомые поля внутри элемента массива сохраняются', () => {
    const r = merge(base, edit({ tasks: [{ id: A, title: 'Первая', done: false, estimate: 3 }, T[1]!] }), edit({ tasks: [{ id: A, title: 'Первая', done: true }, T[1]!] }))
    expect(r.conflicts).toEqual([])
    expect((r.merged.tasks as JsonObject[])[0]).toEqual({ id: A, title: 'Первая', done: true, estimate: 3 })
  })

  it('ключ __proto__ из JSON остаётся обычным полем и не меняет прототип', () => {
    const evil = JSON.parse('{"schemaVersion":1,"slug":"bot","__proto__":{"polluted":true}}') as JsonObject
    const r = merge(undefined, evil, JSON.parse('{"schemaVersion":1,"slug":"bot","__proto__":{"polluted":true}}') as JsonObject)
    expect(Object.getPrototypeOf(r.merged)).toBe(Object.prototype)
    expect(Object.keys(r.merged)).toContain('__proto__')
    expect((r.merged as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('граничные случаи', () => {
  it('базы нет: совпадающее — как есть, расходящееся — конфликт, id-массивы объединяются, updatedAt — позднее', () => {
    const l = edit({ title: 'Л', tasks: [{ id: A, title: 'Первая', done: false }], updatedAt: '2026-09-05T10:00:00+03:00' })
    const rm = edit({ title: 'С', tasks: [{ id: B, title: 'Вторая', done: false }], updatedAt: '2026-09-04T10:00:00+03:00' })
    const r = merge(undefined, l, rm)
    expect(r.conflicts).toEqual([{ kind: 'field', path: ['title'], base: undefined, local: 'Л', remote: 'С' }])
    expect(r.merged.slug).toBe('bot')
    expect(r.merged.updatedAt).toBe('2026-09-05T10:00:00+03:00')
    expect((r.merged.tasks as JsonObject[]).map((t) => t.id)).toEqual([B, A])
  })

  it('обе стороны равны базе — результат равен базе', () => {
    expect(merge(base, base, base)).toEqual({ merged: base, conflicts: [] })
  })

  it('порядок ключей: удалённый, затем новые мои', () => {
    const r = merge(base, edit({ zeta: 1 }), edit({ alpha: 2 }))
    const keys = Object.keys(r.merged)
    expect(keys.slice(-2)).toEqual(['alpha', 'zeta'])
    expect(keys.slice(0, 3)).toEqual(['schemaVersion', 'slug', 'title'])
  })

  it('результат детерминирован и не зависит от порядка ключей во входе', () => {
    const l = edit({ title: 'Л', tasks: [{ id: C, title: 'Новая', done: false }, ...T] })
    const rm = edit({ nextStep: 'С', tasks: [...T, { id: D, title: 'Ещё', done: false }] })
    const reordered = Object.fromEntries(Object.entries(l).reverse()) as JsonObject
    const a = merge(base, l, rm)
    const b = merge(base, reordered, rm)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(merge(base, l, rm))).toBe(JSON.stringify(a))
  })

  it('вход не мутируется, результат не делит ссылки со входом', () => {
    const l = edit({ tasks: [{ id: A, title: 'Первая', done: true }, T[1]!] })
    const rm = edit({ futureField: { keep: false } })
    const snap = JSON.stringify([base, l, rm])
    const r = merge(base, l, rm)
    expect(JSON.stringify([base, l, rm])).toBe(snap)
    ;(r.merged.futureField as JsonObject).keep = 'x'
    ;(r.merged.tasks as JsonObject[])[0]!.title = 'x'
    ;(r.merged.tags as string[]).push('x')
    expect(JSON.stringify([base, l, rm])).toBe(snap)
  })

  it('schemaVersion выше своей с любой стороны — отказ MergeRefused', () => {
    expect(() => merge(base, base, edit({ schemaVersion: 2 }))).toThrow(MergeRefused)
    expect(() => merge(base, edit({ schemaVersion: 2 }), base)).toThrow(MergeRefused)
    expect(() => merge(edit({ schemaVersion: 2 }), base, base)).toThrow(/v2/)
  })

  it('не объект на входе — TypeError', () => {
    expect(() => merge(base, [] as never, base)).toThrow(TypeError)
    expect(() => merge(null as never, base, base)).toThrow(TypeError)
  })
})

describe('equal', () => {
  it('порядок ключей не важен, порядок массива важен, null ≠ отсутствие', () => {
    expect(equal({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(equal([1, 2], [2, 1])).toBe(false)
    expect(equal(null, undefined)).toBe(false)
    expect(equal({ a: undefined as never }, {})).toBe(false)
    expect(equal({}, [])).toBe(false)
  })
})
