// Построчное трёхстороннее слияние длинного текста (ADR-010 §2): база / моя / из репо → куски diff3.
// Чистые функции: без сети, без зависимостей, вход не меняется.
//
// Строки и перевод строк:
// - текст режется на строки ВМЕСТЕ с их окончанием: 'a\r\nb\n' → ['a\r\n', 'b\n'], последняя строка может
//   быть без окончания. Отдельный '\r' без '\n' — часть содержимого строки (старый формат Mac не поддерживаем);
// - строки сравниваются точно, включая окончание. Поэтому 'a\n' и 'a\r\n' — разные строки: смена окончаний —
//   это изменение, а не незаметная подмена;
// - итоговый текст — склейка кусков выбранных версий байт в байт: каждый кусок приносит свои окончания строк
//   из выбранной стороны. Неизменённый кусок одинаков во всех трёх версиях, поэтому неоднозначности нет.
//
// Куски:
// - 'same' — одинаков в моей версии и в версии из репо (не менялся или изменён с обеих сторон одинаково);
//   выбора не требует, в итог идёт как есть;
// - 'local' / 'remote' — изменён только с одной стороны; заранее выбрана изменившая сторона, выбор можно
//   переключить;
// - 'both' — изменён с обеих сторон по-разному; предвыбора нет, выбор обязателен.
// Изменения, между которыми нет ни одной строки, общей для всех трёх версий, попадают в один кусок
// (как в git): правка соседних строк с двух сторон — конфликт 'both', а не два независимых куска.
// Однострочный текст поэтому всегда даёт не больше одного куска.
//
// Алгоритм: строки → числа, общий префикс/суффикс срезаются, середина — Myers O(ND) (своя реализация).
// Совпадения база↔моя и база↔из репо дают «устойчивые» строки базы (совпавшие с обеими сторонами),
// между ними — изменённые участки.

export type Side = 'local' | 'remote'

export type ChunkKind = 'same' | Side | 'both'

export interface TextChunk {
  kind: ChunkKind
  /** Текст куска в каждой версии (строки с окончаниями, склеенные). */
  base: string
  local: string
  remote: string
  /** Выбранная заранее сторона: для 'local'/'remote' — изменившая, для 'same' и 'both' — null. */
  preselected: Side | null
}

/** Выбор для каждого куска по индексу; null — не выбран (для 'same' не нужен). */
export type ChunkChoices = ReadonlyArray<Side | null>

/** Разбить текст на строки вместе с '\n' (и '\r\n'). Пустой текст — пустой список. */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) break
    lines.push(text.slice(start, nl + 1))
    start = nl + 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/**
 * Для каждой строки a — индекс совпавшей строки b или -1 (наибольшая общая подпоследовательность, Myers).
 * Совпадения строго возрастают по обоим индексам.
 */
export function matchLines(a: readonly string[], b: readonly string[]): Int32Array {
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) {
      v = ids.size
      ids.set(s, v)
    }
    return v
  }
  const A = a.map(id)
  const B = b.map(id)
  const match = new Int32Array(A.length).fill(-1)

  let pre = 0
  while (pre < A.length && pre < B.length && at(A, pre) === at(B, pre)) {
    match[pre] = pre
    pre++
  }
  let suf = 0
  while (suf < A.length - pre && suf < B.length - pre && at(A, A.length - 1 - suf) === at(B, B.length - 1 - suf)) {
    match[A.length - 1 - suf] = B.length - 1 - suf
    suf++
  }
  myers(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf), (x, y) => {
    match[pre + x] = pre + y
  })
  return match
}

/** Чтение из массива чисел при noUncheckedIndexedAccess: индексы в пределах по построению, иначе dflt. */
const at = (a: ArrayLike<number>, i: number, dflt = 0): number => a[i] ?? dflt

/** Myers O(ND): вызывает onMatch(x, y) для каждой пары совпавших элементов кратчайшего редактирования. */
function myers(A: readonly number[], B: readonly number[], onMatch: (x: number, y: number) => void): void {
  const n = A.length
  const m = B.length
  if (n === 0 || m === 0) return
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] — снимок v[-d..d] перед шагом d (нужен для обратного прохода).
  const trace: Int32Array[] = []
  const pick = (get: (k: number) => number, k: number, d: number): number =>
    k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      const prevK = pick((i) => at(v, off + i), k, d)
      let x = prevK === k + 1 ? at(v, off + k + 1) : at(v, off + k - 1) + 1
      let y = x - k
      while (x < n && y < m && at(A, x) === at(B, y)) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        backtrack(trace, n, m, pick, onMatch)
        return
      }
    }
  }
}

function backtrack(
  trace: Int32Array[],
  n: number,
  m: number,
  pick: (get: (k: number) => number, k: number, d: number) => number,
  onMatch: (x: number, y: number) => void,
): void {
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d] ?? new Int32Array(0)
    const get = (k: number): number => at(snap, k + d)
    const k = x - y
    const prevK = pick(get, k, d)
    const prevX = d === 0 ? 0 : get(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      onMatch(x, y)
    }
    x = prevX
    y = prevY
  }
}

/** Разбить три версии текста на куски diff3. */
export function diff3Chunks(base: string, local: string, remote: string): TextChunk[] {
  const O = splitLines(base)
  const L = splitLines(local)
  const R = splitLines(remote)
  const mL = matchLines(O, L)
  const mR = matchLines(O, R)
  const chunks: TextChunk[] = []

  const pushSame = (text: string, baseText: string): void => {
    if (text === '' && baseText === '') return
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'same') {
      last.base += baseText
      last.local += text
      last.remote += text
    } else {
      chunks.push({ kind: 'same', base: baseText, local: text, remote: text, preselected: null })
    }
  }

  let i = 0
  let j = 0
  let k = 0
  for (;;) {
    // Следующая устойчивая строка базы: совпала и с моей версией, и с версией из репо.
    let s = i
    while (s < O.length && (at(mL, s, -1) < 0 || at(mR, s, -1) < 0)) s++
    const jEnd = s < O.length ? at(mL, s, -1) : L.length
    const kEnd = s < O.length ? at(mR, s, -1) : R.length

    const b = O.slice(i, s).join('')
    const l = L.slice(j, jEnd).join('')
    const r = R.slice(k, kEnd).join('')
    const localChanged = l !== b
    const remoteChanged = r !== b
    if (localChanged && remoteChanged && l !== r) {
      chunks.push({ kind: 'both', base: b, local: l, remote: r, preselected: null })
    } else if (localChanged && !remoteChanged) {
      chunks.push({ kind: 'local', base: b, local: l, remote: r, preselected: 'local' })
    } else if (remoteChanged && !localChanged) {
      chunks.push({ kind: 'remote', base: b, local: l, remote: r, preselected: 'remote' })
    } else {
      pushSame(l, b)
    }

    if (s >= O.length) break
    const stable = O[s] ?? ''
    pushSame(stable, stable)
    i = s + 1
    j = jEnd + 1
    k = kEnd + 1
  }
  return chunks
}

/** Начальный выбор: предвыбранные стороны, у 'both' и 'same' — null. */
export function initialChoices(chunks: readonly TextChunk[]): Array<Side | null> {
  return chunks.map((c) => c.preselected)
}

/** Нужен ли выбор для куска. */
export function needsChoice(chunk: TextChunk): boolean {
  return chunk.kind !== 'same'
}

/** Все куски, требующие выбора, выбраны («Применить» активна). */
export function allChosen(chunks: readonly TextChunk[], choices: ChunkChoices): boolean {
  return chunks.every((c, i) => !needsChoice(c) || choices[i] === 'local' || choices[i] === 'remote')
}

/** Итоговый текст по выбору; null, если выбраны не все куски. */
export function buildText(chunks: readonly TextChunk[], choices: ChunkChoices): string | null {
  if (!allChosen(chunks, choices)) return null
  let out = ''
  chunks.forEach((c, i) => {
    out += !needsChoice(c) ? c.local : choices[i] === 'local' ? c.local : c.remote
  })
  return out
}
