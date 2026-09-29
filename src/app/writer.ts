// Пишущая вкладка (ADR-013): правит, ставит в очередь и отправляет только одна вкладка хаба на устройстве.
// Она держит эксклюзивный Web Lock, пока жива или пока сама не уступит («Писать здесь» в другой вкладке).
// Остальные вкладки — только просмотр; каждая ждёт тот же лок и становится пишущей, когда он освободился.
// Без Web Locks (старый браузер или отказ браузера) вкладка считается пишущей.

export const WRITER_LOCK = 'hub-writer'

type Locks = Pick<LockManager, 'request'>

let claim: Promise<boolean> | null = null
let writer = false
let claimed = false
let manager: Locks | undefined
/** Отпустить удерживаемый лок: уступить другой вкладке (или «закрыть вкладку» в тестах). */
let release: (() => void) | null = null
let waiting: AbortController | null = null
const promoted = new Set<() => void>()
const demoted = new Set<() => void>()

function locksOf(): Locks | undefined {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Partial<Navigator>)
  const locks = nav?.locks
  return locks && typeof locks.request === 'function' ? locks : undefined
}

/** Промис, который держит лок, пока вкладка пишет. */
function hold(): Promise<void> {
  return new Promise<void>((resolve) => (release = resolve))
}

function becameWriter(): Promise<void> {
  // Лишний запрос (например, ожидание, отменённое слишком поздно) при уже пишущей вкладке — сразу отпустить.
  if (writer) return Promise.resolve()
  waiting = null
  writer = true
  for (const fn of promoted) fn()
  return hold()
}

/** Встать в очередь за локом. Браузер отказал — остаёмся в просмотре: писать рядом с живой пишущей нельзя. */
function wait(locks: Locks): void {
  const ac = new AbortController()
  waiting = ac
  try {
    locks.request(WRITER_LOCK, { signal: ac.signal }, becameWriter).catch(() => undefined) // отмена ожидания — не ошибка
  } catch {
    /* ждать не вышло — вкладка остаётся в просмотре до перезапуска */
  }
}

function asWriter(): boolean {
  writer = true
  claimed = true
  return true
}

function start(locks: Locks | undefined): Promise<boolean> {
  if (!locks) return Promise.resolve(asWriter())
  manager = locks
  return new Promise<boolean>((resolve) => {
    // Браузер отказал в Web Locks (синхронно или промисом) — как без них: вкладка пишет одна.
    const refused = () => resolve(asWriter())
    try {
      locks
        .request(WRITER_LOCK, { ifAvailable: true }, (lock) => {
          claimed = true
          if (!lock) {
            writer = false
            resolve(false)
            wait(locks)
            return undefined
          }
          writer = true
          resolve(true)
          return hold()
        })
        .catch(refused)
    } catch {
      refused()
    }
  })
}

/** Занять место пишущей вкладки. Повторный вызов возвращает тот же ответ. true — эта вкладка пишет. */
export function claimWriter(): Promise<boolean> {
  claim ??= start(locksOf())
  return claim
}

/** Пишет ли эта вкладка сейчас. До claimWriter — false. */
export function isWriter(): boolean {
  return writer
}

/** Точно известно, что пишет другая вкладка: лок спрошен и не у нас. До claimWriter — false. */
export function isReader(): boolean {
  return claimed && !writer
}

/** Подписка на «эта вкладка стала пишущей». Возвращает отписку. */
export function onBecameWriter(fn: () => void): () => void {
  promoted.add(fn)
  return () => promoted.delete(fn)
}

/** Подписка на «эта вкладка уступила запись и стала просмотром». Возвращает отписку. */
export function onBecameReader(fn: () => void): () => void {
  demoted.add(fn)
  return () => demoted.delete(fn)
}

/**
 * Уступить запись (true — уступили): вкладка становится просмотром (подписчики узнают об этом до того, как лок уйдёт),
 * отпускает лок и сама встаёт в очередь за ним — за той вкладкой, что попросила.
 */
export function yieldWriter(): boolean {
  // Без Web Locks отпускать нечего: другая вкладка всё равно не получила бы запись — отказ.
  if (!writer || !release || !manager) return false
  writer = false
  for (const fn of demoted) fn()
  const r = release
  release = null
  wait(manager)
  r()
  return true
}

/** Другая вкладка попросила запись: уступить ей место в очереди — встать в её конец. */
export function requeueWriter(): void {
  if (!waiting || !manager) return
  waiting.abort()
  wait(manager)
}

/** Только для тестов: отпустить лок и ожидание, как при закрытии вкладки, и забыть ответ. */
export function resetWriter(): void {
  release?.()
  release = null
  waiting?.abort()
  waiting = null
  claim = null
  writer = false
  claimed = false
  manager = undefined
}
