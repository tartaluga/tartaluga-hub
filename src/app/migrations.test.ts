import { afterEach, describe, expect, it } from 'vitest'
import { buildHandoff, resetDrafts, setDraft } from '../lib/drafts'
import { MIGRATIONS, MigrationError, migrateState, STATE_VERSION, type Migration } from './migrations'

/**
 * Отпечаток формата локального состояния для каждой версии. Меняешь формат handoff (или позже очереди/kv) —
 * тест ниже упадёт: повысь STATE_VERSION, допиши функцию в MIGRATIONS, пример в EXAMPLES и строку сюда.
 * Старые строки не меняются.
 */
const FORMATS: Record<number, string> = {
  1: '{at:number,build:string,drafts:[{key:string,label:string,text:string}],route:string,stateVersion:number,ui:{scrollY:number}}',
}

/** Пример состояния версии n (вход для MIGRATIONS[n - 1]) и что должно выйти. */
const EXAMPLES: Record<number, { input: unknown; output: unknown }> = {}

function shape(x: unknown): string {
  if (Array.isArray(x)) return `[${x.length ? shape(x[0]) : ''}]`
  if (x !== null && typeof x === 'object') {
    const entries = Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${k}:${shape(v)}`).join(',')}}`
  }
  return x === null ? 'null' : typeof x
}

afterEach(() => resetDrafts())

describe('цепочка миграций полная', () => {
  it('функций ровно STATE_VERSION − 1, отпечатков — STATE_VERSION', () => {
    expect(MIGRATIONS).toHaveLength(STATE_VERSION - 1)
    expect(Object.keys(FORMATS).map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: STATE_VERSION }, (_, i) => i + 1))
  })

  it('формат handoff совпадает с записанным для текущей версии (иначе нужна миграция)', () => {
    setDraft('project:hub:summary', 'Описание', 'текст')
    const h = buildHandoff({ route: '#/projects/hub', scrollY: 10, now: 1, build: 'abc' })
    expect(h.stateVersion).toBe(STATE_VERSION)
    expect(shape(h)).toBe(FORMATS[STATE_VERSION])
  })

  it('у каждой функции есть пример прошлой версии, и он мигрирует как ожидается', () => {
    for (let v = 1; v < STATE_VERSION; v++) {
      const ex = EXAMPLES[v]
      expect(ex, `нет примера для миграции ${v} → ${v + 1}`).toBeDefined()
      expect(MIGRATIONS[v - 1]!(ex!.input)).toEqual(ex!.output)
    }
  })
})

describe('migrateState', () => {
  const chain: Migration[] = [
    (s) => ({ ...(s as object), b: 1 }),
    (s) => {
      const o = s as { b?: number }
      if (o.b !== 1) throw new Error('нет b')
      return { ...o, c: 2 }
    },
  ]

  it('та же версия — без изменений', () => {
    const s = { a: 1 }
    expect(migrateState(s, 3, 3, chain)).toBe(s)
  })

  it('прогоняет всю цепочку по порядку и не меняет исходник', () => {
    const s = { a: 1 }
    expect(migrateState(s, 1, 3, chain)).toEqual({ a: 1, b: 1, c: 2 })
    expect(s).toEqual({ a: 1 })
    expect(migrateState({ b: 1 }, 2, 3, chain)).toEqual({ b: 1, c: 2 })
  })

  it('версия новее сборки (откат деплоя) — ошибка', () => {
    expect(() => migrateState({}, 4, 3, chain)).toThrow(MigrationError)
  })

  it.each([0, -1, 1.5, '1', undefined, null])('мусор вместо версии (%s) — ошибка', (v) => {
    expect(() => migrateState({}, v, 3, chain)).toThrow(MigrationError)
  })

  it('дырка в цепочке — ошибка, а не молчаливый пропуск', () => {
    expect(() => migrateState({}, 1, 4, chain)).toThrow(/3 → 4/)
  })

  it('упавшая функция — MigrationError с номером шага', () => {
    expect(() => migrateState({}, 2, 3, chain)).toThrow(/2 → 3.*нет b/)
  })
})
