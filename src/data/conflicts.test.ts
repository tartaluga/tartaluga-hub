// Входящие конфликты: подписи, показ значений, применение выбора (ADR-004 шаг 5, ADR-010 §2).
import { describe, expect, it } from 'vitest'
import { applyOps, conflictLabel, formatValue, isLongText, opsFor, sameContent, sideText } from './conflicts'
import type { MergeConflict } from './merge'

const field = (path: string[], base: unknown, local: unknown, remote: unknown) =>
  ({ kind: 'field', path, base, local, remote }) as MergeConflict

describe('подписи спорных мест', () => {
  it('поле верхнего уровня — по-русски, незнакомое — как есть', () => {
    expect(conflictLabel(field(['nextStep'], 'а', 'б', 'в'), {}, {})).toBe('следующий шаг')
    expect(conflictLabel(field(['x-custom'], 1, 2, 3), {}, {})).toBe('x-custom')
    // Поля идеи и ключи, совпадающие со свойствами прототипа.
    expect(conflictLabel(field(['text'], 'а', 'б', 'в'), {}, {})).toBe('текст')
    expect(conflictLabel(field(['project'], 'a', 'b', 'c'), {}, {})).toBe('привязка к проекту')
    expect(conflictLabel(field(['tags'], [], ['x'], ['y']), {}, {})).toBe('теги')
    expect(conflictLabel(field(['constructor'], 1, 2, 3), {}, {})).toBe('constructor')
    expect(conflictLabel(field(['toString'], 1, 2, 3), {}, {})).toBe('toString')
  })

  it('поле элемента — имя элемента из репо и поле', () => {
    const remote = { tasks: [{ id: 't1', title: 'Сдать главу' }] }
    expect(conflictLabel(field(['tasks', 't1', 'due'], null, '2026-10-01', '2026-10-02'), {}, remote)).toBe('задача «Сдать главу» · срок')
  })

  it('удалённый элемент — кто удалил', () => {
    const item: MergeConflict = { kind: 'element', path: ['tasks', 't1'], deletedBy: 'remote', base: { id: 't1', title: 'Макет' }, local: { id: 't1', title: 'Макет 2' }, remote: undefined }
    expect(conflictLabel(item, {}, {})).toBe('задача «Макет 2» · удалена в репо')
    expect(sideText(item, 'remote')).toBe('удалена')
    expect(sideText(item, 'local')).toBe('Макет 2')
  })
})

describe('показ значений', () => {
  it('пусто, статус, отметка, списки строк', () => {
    expect(formatValue(undefined)).toBe('— пусто')
    expect(formatValue('')).toBe('— пусто')
    expect(formatValue('active', 'status')).toBe('в работе')
    expect(formatValue(true, 'done')).toBe('выполнена')
    expect(formatValue(['web', 'hw'])).toBe('web, hw')
  })

  it('разметка из репо остаётся текстом', () => {
    expect(formatValue('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('длинный текст — выбор по кускам', () => {
  it('многострочное описание — да, однострочное и не текстовые поля — нет', () => {
    expect(isLongText(field(['description'], 'а\nб', 'а\nв', 'г\nб'))).toBe(true)
    expect(isLongText(field(['log', 'l1', 'text'], 'а', 'а\nб', 'а'))).toBe(true)
    expect(isLongText(field(['description'], 'а', 'б', 'в'))).toBe(false)
    expect(isLongText(field(['nextStep'], 'а\nб', 'в\nг', 'д'))).toBe(false)
  })
})

describe('применение выбора', () => {
  it('«из репо» ничего не меняет, «моя» ставит моё значение, куски — собранный текст', () => {
    const item = field(['nextStep'], 'а', 'моё', 'репо')
    expect(opsFor(item, 'repo')).toEqual([])
    expect(applyOps({ nextStep: 'репо' }, opsFor(item, 'mine'))).toEqual({ nextStep: 'моё' })
    expect(applyOps({ nextStep: 'репо' }, opsFor(item, { text: 'сборка' }))).toEqual({ nextStep: 'сборка' })
  })

  it('моё «поля нет» убирает поле', () => {
    expect(applyOps({ nextStep: 'репо', title: 'А' }, opsFor(field(['nextStep'], 'а', undefined, 'репо'), 'mine'))).toEqual({ title: 'А' })
  })

  it('поле элемента по id; удаление последнего элемента убирает массив', () => {
    const doc = { tasks: [{ id: 't1', title: 'А', due: null }] }
    expect(applyOps(doc, opsFor(field(['tasks', 't1', 'due'], null, '2026-10-01', null), 'mine'))).toEqual({ tasks: [{ id: 't1', title: 'А', due: '2026-10-01' }] })
    const del: MergeConflict = { kind: 'element', path: ['tasks', 't1'], deletedBy: 'remote', base: { id: 't1' }, local: { id: 't1', title: 'Б' }, remote: undefined }
    expect(applyOps(doc, opsFor(del, 'repo'))).toEqual({})
    expect(applyOps(doc, opsFor(del, 'mine'))).toEqual(doc)
    expect(doc.tasks).toHaveLength(1) // исходный объект не тронут
  })

  it('ключ __proto__ из репо не меняет прототип', () => {
    const out = applyOps({}, [{ path: ['__proto__'], value: { polluted: true } }])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('элемента уже нет — правка поля ничего не делает', () => {
    expect(applyOps({ tasks: [] }, [{ path: ['tasks', 'nope', 'title'], value: 'x' }])).toEqual({ tasks: [] })
  })
})

describe('совпадение без служебных меток', () => {
  it('updatedAt и doneAt не считаются, порядок ключей тоже', () => {
    expect(sameContent({ a: 1, updatedAt: 'x', tasks: [{ id: 't', doneAt: '1' }] }, { tasks: [{ id: 't', doneAt: '2' }], updatedAt: 'y', a: 1 })).toBe(true)
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('задача: подписи и выбор (ADR-016)', () => {
  const T = '01K5Z0000000000000000000T1'
  const K = '01K5Z0000000000000000000K1'
  const L = '01K5Z0000000000000000000L1'
  const doc = {
    tasks: [
      {
        id: T,
        title: 'Сдать главу',
        links: [{ id: L, kind: 'doc', value: 'https://example.com/spec', label: 'Спека' }],
        comments: [{ id: K, text: 'Сделал X' }],
      },
    ],
  }

  it('поля задачи — по-русски', () => {
    const label = (field: string) => conflictLabel(field_(['tasks', T, field]), doc, doc)
    const field_ = (path: string[]) => field(path, 'а', 'б', 'в')
    expect(label('description')).toBe('задача «Сдать главу» · описание')
    expect(label('inProgress')).toBe('задача «Сдать главу» · в работе')
    expect(label('cancelled')).toBe('задача «Сдать главу» · отменена')
    expect(label('milestoneId')).toBe('задача «Сдать главу» · веха')
    expect(label('links')).toBe('задача «Сдать главу» · ссылки')
    expect(label('comments')).toBe('задача «Сдать главу» · комментарии')
  })

  it('banner и cover — по-русски', () => {
    expect(conflictLabel(field(['banner'], null, 'a', 'b'), {}, {})).toBe('шапка')
    expect(conflictLabel(field(['cover'], null, 'a', 'b'), {}, {})).toBe('обложка')
  })

  it('ссылка и комментарий задачи: имя задачи, имя элемента и поле', () => {
    expect(conflictLabel(field(['tasks', T, 'links', L, 'value'], 'a', 'b', 'c'), doc, doc)).toBe('задача «Сдать главу» · ссылка «Спека» · адрес')
    expect(conflictLabel(field(['tasks', T, 'comments', K, 'text'], 'a', 'b', 'c'), doc, doc)).toBe('задача «Сдать главу» · комментарий «Сделал X» · текст')
    const gone: MergeConflict = { kind: 'element', path: ['tasks', T, 'comments', K], deletedBy: 'remote', base: { id: K, text: 'Сделал X' }, local: { id: K, text: 'Сделал X, Y' }, remote: undefined }
    expect(conflictLabel(gone, doc, doc)).toBe('задача «Сдать главу» · комментарий «Сделал X, Y» · удалён в репо')
    const goneLink: MergeConflict = { kind: 'element', path: ['tasks', T, 'links', L], deletedBy: 'local', base: { id: L, value: 'https://e/' }, local: undefined, remote: { id: L, value: 'https://e2/' } }
    expect(conflictLabel(goneLink, doc, doc)).toBe('задача «Сдать главу» · ссылка «https://e2/» · удалена у тебя')
  })

  it('задачи уже нет ни в одной версии — подпись без имени, а не падение', () => {
    expect(conflictLabel(field(['tasks', T, 'comments', K, 'text'], 'a', 'b', 'c'), {}, {})).toBe('задача · комментарий · текст')
  })

  it('ключи-прототипы не находят подписей', () => {
    expect(conflictLabel(field(['tasks', T, 'constructor'], 1, 2, 3), doc, doc)).toBe('задача «Сдать главу» · constructor')
    expect(conflictLabel(field(['tasks', T, 'toString', K, 'text'], 1, 2, 3), doc, doc)).toBe('задача «Сдать главу» · текст')
  })

  it('длинный текст: описание задачи и текст комментария — по кускам, однострочные и другие поля — нет', () => {
    expect(isLongText(field(['tasks', T, 'description'], 'а\nб', 'а\nв', 'г\nб'))).toBe(true)
    expect(isLongText(field(['tasks', T, 'comments', K, 'text'], 'а\nб', 'а\nв', 'г\nб'))).toBe(true)
    expect(isLongText(field(['tasks', T, 'description'], 'а', 'б', 'в'))).toBe(false)
    expect(isLongText(field(['tasks', T, 'title'], 'а\nб', 'в\nг', 'д'))).toBe(false)
    expect(isLongText(field(['tasks', T, 'links', L, 'value'], 'а\nб', 'в\nг', 'д'))).toBe(false)
    expect(isLongText(field(['banner'], 'а\nб', 'в\nг', 'д'))).toBe(false)
  })

  it('выбор по куску ставит описание задачи; «моя» ставит моё значение; последний комментарий удалён — массив убран', () => {
    const d = { tasks: [{ id: T, title: 'З', description: 'репо', comments: [{ id: K, text: 'х' }] }] }
    const item = field(['tasks', T, 'description'], 'а', 'моё', 'репо')
    expect(applyOps(d, opsFor(item, { text: 'сборка' })).tasks).toEqual([{ id: T, title: 'З', description: 'сборка', comments: [{ id: K, text: 'х' }] }])
    expect(applyOps(d, opsFor(item, 'mine')).tasks).toEqual([{ id: T, title: 'З', description: 'моё', comments: [{ id: K, text: 'х' }] }])
    const del: MergeConflict = { kind: 'element', path: ['tasks', T, 'comments', K], deletedBy: 'remote', base: { id: K }, local: { id: K, text: 'х!' }, remote: undefined }
    expect(applyOps(d, opsFor(del, 'repo')).tasks).toEqual([{ id: T, title: 'З', description: 'репо' }])
  })

  it('значения: булевы метки и шапка', () => {
    expect(formatValue(true, 'inProgress')).toBe('да')
    expect(formatValue('banners/a.webp', 'banner')).toBe('banners/a.webp')
    expect(formatValue(undefined, 'cancelled')).toBe('— пусто')
  })
})
