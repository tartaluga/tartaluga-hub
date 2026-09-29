// Пишущая вкладка (ADR-013): правит, ставит в очередь и отправляет только одна вкладка хаба на устройстве.
// Она держит эксклюзивный Web Lock всю свою жизнь. Остальные вкладки — только просмотр; каждая ждёт тот же лок
// и становится пишущей, когда прежняя закрылась. Без Web Locks (старый браузер) вкладка считается пишущей.

export const WRITER_LOCK = 'hub-writer'

type Locks = Pick<LockManager, 'request'>

let claim: Promise<boolean> | null = null
let writer = false
/** Отпустить лок: только для тестов («вкладку закрыли»). В жизни лок держится до закрытия вкладки. */
let release: (() => void) | null = null
let waiting: AbortController | null = null
const promoted = new Set<() => void>()

function locksOf(): Locks | undefined {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Partial<Navigator>)
  const locks = nav?.locks
  return locks && typeof locks.request === 'function' ? locks : undefined
}

/** Промис, который держит лок, пока вкладка жива. */
function hold(): Promise<void> {
  return new Promise<void>((resolve) => (release = resolve))
}

function becameWriter(): Promise<void> {
  waiting = null
  writer = true
  for (const fn of promoted) fn()
  return hold()
}

function wait(locks: Locks): void {
  const ac = new AbortController()
  waiting = ac
  locks.request(WRITER_LOCK, { signal: ac.signal }, becameWriter).catch(() => undefined) // отмена ожидания — не ошибка
}

function start(locks: Locks | undefined): Promise<boolean> {
  if (!locks) {
    writer = true
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    locks
      .request(WRITER_LOCK, { ifAvailable: true }, (lock) => {
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
      .catch(() => {
        // Браузер отказал в Web Locks (например, особый контекст) — как без них: одна вкладка.
        writer = true
        resolve(true)
      })
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

/** Подписка на «эта вкладка стала пишущей» (прежняя закрылась). Возвращает отписку. */
export function onBecameWriter(fn: () => void): () => void {
  promoted.add(fn)
  return () => promoted.delete(fn)
}

/** Только для тестов: отпустить лок и ожидание, как при закрытии вкладки, и забыть ответ. */
export function resetWriter(): void {
  release?.()
  release = null
  waiting?.abort()
  waiting = null
  claim = null
  writer = false
}
