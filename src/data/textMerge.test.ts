import { describe, expect, it } from 'vitest'
import {
  allChosen,
  buildText,
  diff3Chunks,
  initialChoices,
  matchLines,
  splitLines,
  type Side,
  type TextChunk,
} from './textMerge'

const kinds = (chunks: TextChunk[]) => chunks.map((c) => c.kind)
const all = (chunks: TextChunk[], side: Side) => chunks.map(() => side)

/** Длина LCS обычным ДП — эталон для Myers. */
function lcsLength(a: string[], b: string[]): number {
  const w = b.length + 1
  const dp = new Array<number>((a.length + 1) * w).fill(0)
  const at = (i: number, j: number) => dp[i * w + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  return at(0, 0)
}

/** Детерминированный ГПСЧ (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('splitLines', () => {
  it('режет с окончаниями, последняя строка без окончания', () => {
    expect(splitLines('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c'])
    expect(splitLines('a\n')).toEqual(['a\n'])
    expect(splitLines('\n\n')).toEqual(['\n', '\n'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\rb')).toEqual(['a\rb'])
  })
})

describe('matchLines', () => {
  it('совпадения строго возрастают и дают наибольшую общую подпоследовательность', () => {
    const rand = rng(42)
    for (let n = 0; n < 300; n++) {
      const gen = () => Array.from({ length: Math.floor(rand() * 9) }, () => 'abc'.charAt(Math.floor(rand() * 3)))
      const a = gen()
      const b = gen()
      const m = matchLines(a, b)
      let last = -1
      let count = 0
      m.forEach((j, i) => {
        if (j < 0) return
        expect(j).toBeGreaterThan(last)
        expect(b[j]).toBe(a[i])
        last = j
        count++
      })
      expect(count).toBe(lcsLength(a, b))
    }
  })

  it('пустые входы', () => {
    expect(Array.from(matchLines([], ['a']))).toEqual([])
    expect(Array.from(matchLines(['a'], []))).toEqual([-1])
  })
})

describe('diff3Chunks', () => {
  it('без изменений — один неизменённый кусок, выбор не нужен', () => {
    const t = 'Первая строка\nвторая\n'
    const c = diff3Chunks(t, t, t)
    expect(kinds(c)).toEqual(['same'])
    expect(allChosen(c, initialChoices(c))).toBe(true)
    expect(buildText(c, initialChoices(c))).toBe(t)
  })

  it('пустой текст во всех версиях — ни одного куска, итог пустой', () => {
    const c = diff3Chunks('', '', '')
    expect(c).toEqual([])
    expect(buildText(c, [])).toBe('')
  })

  it('однострочный текст, изменённый с обеих сторон, — один кусок с обязательным выбором', () => {
    const c = diff3Chunks('Привет', 'Привет, мир', 'Привет всем')
    expect(c).toEqual([{ kind: 'both', base: 'Привет', local: 'Привет, мир', remote: 'Привет всем', preselected: null }])
    expect(allChosen(c, initialChoices(c))).toBe(false)
    expect(buildText(c, initialChoices(c))).toBeNull()
    expect(buildText(c, ['remote'])).toBe('Привет всем')
    expect(buildText(c, ['local'])).toBe('Привет, мир')
  })

  it('однострочный текст, изменённый с одной стороны, — один кусок с предвыбором', () => {
    const c = diff3Chunks('раз', 'раз', 'два')
    expect(c).toEqual([{ kind: 'remote', base: 'раз', local: 'раз', remote: 'два', preselected: 'remote' }])
    expect(buildText(c, initialChoices(c))).toBe('два')
    expect(buildText(c, ['local'])).toBe('раз')
  })

  it('изменение только с одной стороны — предвыбрана изменившая сторона, переключается', () => {
    const base = 'а\nб\nв\nг\n'
    const local = 'а\nБ\nв\nг\n'
    const remote = 'а\nб\nв\nГ\n'
    const c = diff3Chunks(base, local, remote)
    expect(kinds(c)).toEqual(['same', 'local', 'same', 'remote'])
    expect(c[1]).toMatchObject({ base: 'б\n', local: 'Б\n', remote: 'б\n', preselected: 'local' })
    expect(c[3]).toMatchObject({ base: 'г\n', local: 'г\n', remote: 'Г\n', preselected: 'remote' })
    expect(allChosen(c, initialChoices(c))).toBe(true)
    expect(buildText(c, initialChoices(c))).toBe('а\nБ\nв\nГ\n')
    expect(buildText(c, [null, 'remote', null, 'local'])).toBe(base)
  })

  it('одинаковое изменение с обеих сторон — не конфликт', () => {
    const c = diff3Chunks('а\nб\nв\n', 'а\nБ\nв\n', 'а\nБ\nв\n')
    expect(kinds(c)).toEqual(['same'])
    expect(c[0]).toMatchObject({ base: 'а\nб\nв\n', local: 'а\nБ\nв\n', remote: 'а\nБ\nв\n' })
    expect(buildText(c, initialChoices(c))).toBe('а\nБ\nв\n')
  })

  it('одинаковое удаление с обеих сторон — не конфликт', () => {
    const c = diff3Chunks('а\nб\n', 'а\n', 'а\n')
    expect(kinds(c)).toEqual(['same'])
    expect(buildText(c, [])).toBe('а\n')
  })

  it('соседние строки изменены с двух сторон — один кусок с обязательным выбором (как в git)', () => {
    const c = diff3Chunks('а\nб\nв\nг\n', 'а\nБ\nв\nг\n', 'а\nб\nВ\nг\n')
    expect(kinds(c)).toEqual(['same', 'both', 'same'])
    expect(c[1]).toMatchObject({ base: 'б\nв\n', local: 'Б\nв\n', remote: 'б\nВ\n', preselected: null })
    expect(buildText(c, [null, 'local', null])).toBe('а\nБ\nв\nг\n')
  })

  it('изменения, разделённые общей строкой, — независимые куски', () => {
    const c = diff3Chunks('а\nб\nв\n', 'А\nб\nв\n', 'а\nб\nВ\n')
    expect(kinds(c)).toEqual(['local', 'same', 'remote'])
    expect(buildText(c, initialChoices(c))).toBe('А\nб\nВ\n')
  })

  it('вставка и удаление в начале', () => {
    const base = 'б\nв\n'
    const ins = diff3Chunks(base, 'а\nб\nв\n', base)
    expect(kinds(ins)).toEqual(['local', 'same'])
    expect(ins[0]).toMatchObject({ base: '', local: 'а\n', remote: '' })
    expect(buildText(ins, initialChoices(ins))).toBe('а\nб\nв\n')

    const del = diff3Chunks(base, base, 'в\n')
    expect(kinds(del)).toEqual(['remote', 'same'])
    expect(del[0]).toMatchObject({ base: 'б\n', local: 'б\n', remote: '' })
    expect(buildText(del, initialChoices(del))).toBe('в\n')
  })

  it('вставка и удаление в конце, в том числе последней строки без перевода строки', () => {
    const ins = diff3Chunks('а\nб', 'а\nб', 'а\nб\nв')
    expect(kinds(ins)).toEqual(['same', 'remote'])
    expect(buildText(ins, initialChoices(ins))).toBe('а\nб\nв')

    const del = diff3Chunks('а\nб\nв\n', 'а\nб\n', 'а\nб\nв\n')
    expect(kinds(del)).toEqual(['same', 'local'])
    expect(del[1]).toMatchObject({ base: 'в\n', local: '', remote: 'в\n' })
    expect(buildText(del, initialChoices(del))).toBe('а\nб\n')
  })

  it('вставки в одном месте с обеих сторон по-разному — конфликт', () => {
    const c = diff3Chunks('а\nв\n', 'а\nб1\nв\n', 'а\nб2\nв\n')
    expect(kinds(c)).toEqual(['same', 'both', 'same'])
    expect(c[1]).toMatchObject({ base: '', local: 'б1\n', remote: 'б2\n' })
  })

  it('пустые строки внутри текста сохраняются', () => {
    const base = 'а\n\n\nб\n'
    const c = diff3Chunks(base, 'а\n\nб\n', 'а\n\n\nб\nв\n')
    expect(kinds(c)).toEqual(['same', 'local', 'same', 'remote'])
    expect(buildText(c, initialChoices(c))).toBe('а\n\nб\nв\n')
  })

  it('весь текст стёрт с одной стороны — предвыбрано удаление', () => {
    const c = diff3Chunks('а\nб\n', '', 'а\nб\n')
    expect(c).toEqual([{ kind: 'local', base: 'а\nб\n', local: '', remote: 'а\nб\n', preselected: 'local' }])
    expect(buildText(c, initialChoices(c))).toBe('')
  })

  it('текст появился с обеих сторон при пустой базе — конфликт', () => {
    const c = diff3Chunks('', 'моё', 'из репо')
    expect(kinds(c)).toEqual(['both'])
  })

  it('эмодзи (суррогатные пары) не разрезаются', () => {
    const base = 'план 🐢\nзадача 👩‍💻\n'
    const c = diff3Chunks(base, 'план 🐢🚀\nзадача 👩‍💻\n', base)
    expect(kinds(c)).toEqual(['local', 'same'])
    expect(c[0]?.local).toBe('план 🐢🚀\n')
    const out = buildText(c, initialChoices(c))
    expect(out).toBe('план 🐢🚀\nзадача 👩‍💻\n')
    expect(out).toBe(out?.normalize())
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out ?? '')).toBe(false)
  })

  it('\\r\\n сохраняется как в выбранной версии', () => {
    const base = 'а\r\nб\r\nв\r\n'
    const c = diff3Chunks(base, 'а\r\nБ\r\nв\r\n', 'а\r\nб\r\nв\r\nг\n')
    expect(kinds(c)).toEqual(['same', 'local', 'same', 'remote'])
    expect(buildText(c, initialChoices(c))).toBe('а\r\nБ\r\nв\r\nг\n')
  })

  it('смена окончаний строк — изменение, а не незаметная подмена', () => {
    const c = diff3Chunks('а\r\nб\r\n', 'а\nб\n', 'а\r\nб\r\n')
    expect(kinds(c)).toEqual(['local'])
    expect(buildText(c, ['remote'])).toBe('а\r\nб\r\n')
    expect(buildText(c, ['local'])).toBe('а\nб\n')
  })

  it('allChosen и buildText требуют выбора для каждого конфликта', () => {
    const c = diff3Chunks('а\nб\nв\n', 'А\nб\nВ1\n', 'А2\nб\nВ2\n')
    expect(kinds(c)).toEqual(['both', 'same', 'both'])
    expect(allChosen(c, ['local', null, null])).toBe(false)
    expect(buildText(c, ['local', null, null])).toBeNull()
    expect(allChosen(c, ['local', null, 'remote'])).toBe(true)
    expect(buildText(c, ['local', null, 'remote'])).toBe('А\nб\nВ2\n')
    expect(allChosen(c, [])).toBe(false)
  })

  it('свойства на случайных текстах: всё «моё» — моя версия, всё «из репо» — версия из репо', () => {
    const rand = rng(7)
    const pool = ['а\n', 'б\n', 'в\r\n', '\n', '🐢\n', 'г']
    const gen = () => Array.from({ length: Math.floor(rand() * 8) }, () => pool[Math.floor(rand() * pool.length)] ?? '').join('')
    for (let n = 0; n < 500; n++) {
      const base = gen()
      const local = rand() < 0.3 ? base : gen()
      const remote = rand() < 0.3 ? base : gen()
      const c = diff3Chunks(base, local, remote)
      expect(buildText(c, all(c, 'local'))).toBe(local)
      expect(buildText(c, all(c, 'remote'))).toBe(remote)
      expect(c.map((x) => x.base).join('')).toBe(base)
      for (const x of c) {
        if (x.kind === 'same') expect(x.local).toBe(x.remote)
        if (x.kind === 'local') expect([x.remote === x.base, x.local !== x.base, x.preselected]).toEqual([true, true, 'local'])
        if (x.kind === 'remote') expect([x.local === x.base, x.remote !== x.base, x.preselected]).toEqual([true, true, 'remote'])
        if (x.kind === 'both') expect([x.local !== x.remote, x.preselected]).toEqual([true, null])
      }
      // Изменена только одна сторона — всё выбрано заранее и итог равен изменённой версии.
      if (local === base) expect(buildText(c, initialChoices(c))).toBe(remote)
      if (remote === base) expect(buildText(c, initialChoices(c))).toBe(local)
      if (local === base || remote === base) expect(c.some((x) => x.kind === 'both')).toBe(false)
      // Однострочные версии — не больше одного куска.
      if ([base, local, remote].every((t) => splitLines(t).length <= 1)) expect(c.length).toBeLessThanOrEqual(1)
    }
  })

  it('длинный текст с редкими правками обрабатывается быстро и точно', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `строка ${i}\n`)
    const base = lines.join('')
    const local = lines.map((l, i) => (i === 10 ? 'моя правка\n' : l)).join('')
    const remote = lines.map((l, i) => (i === 2990 ? 'правка из репо\n' : l)).join('')
    const c = diff3Chunks(base, local, remote)
    expect(kinds(c)).toEqual(['same', 'local', 'same', 'remote', 'same'])
    expect(buildText(c, initialChoices(c))).toBe(
      lines.map((l, i) => (i === 10 ? 'моя правка\n' : i === 2990 ? 'правка из репо\n' : l)).join(''),
    )
  })
})
