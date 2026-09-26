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
