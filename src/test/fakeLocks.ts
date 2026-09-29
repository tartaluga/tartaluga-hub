// Поддельные Web Locks для тестов (в Node и happy-dom нельзя «закрыть вкладку» и отпустить её лок).
// Одна «машина» — общие локи; у каждой вкладки свой LockManager и close(), как закрытие вкладки.

type Callback = (lock: Lock | null) => unknown

interface Lease {
  tab: number
}

interface Waiter {
  tab: number
  cb: Callback
  resolve(v: unknown): void
  reject(e: unknown): void
}

export interface FakeTab {
  locks: Pick<LockManager, 'request'>
  /** Закрыть вкладку: её локи отпускаются, её ожидания снимаются. */
  close(): void
}

export function fakeLockHub(): { tab(): FakeTab; holder(name: string): number | undefined } {
  const held = new Map<string, Lease>()
  const queues = new Map<string, Waiter[]>()
  const closed = new Set<number>()
  let tabs = 0

  const grant = (name: string, w: Waiter) => {
    const lease: Lease = { tab: w.tab }
    held.set(name, lease)
    Promise.resolve()
      .then(() => w.cb({ name, mode: 'exclusive' } as Lock))
      .then(
        (v) => {
          release(name, lease)
          w.resolve(v)
        },
        (e: unknown) => {
          release(name, lease)
          w.reject(e)
        },
      )
  }

  const release = (name: string, lease: Lease) => {
    if (held.get(name) !== lease) return
    held.delete(name)
    const next = queues.get(name)?.shift()
    if (next) grant(name, next)
  }

  return {
    holder: (name) => held.get(name)?.tab,
    tab() {
      const id = ++tabs
      const request = ((name: string, a: LockOptions | Callback, b?: Callback) => {
        const opts: LockOptions = typeof a === 'function' ? {} : a
        const cb = (typeof a === 'function' ? a : b)!
        if (closed.has(id)) return new Promise(() => undefined)
        if (opts.ifAvailable && held.has(name)) return Promise.resolve().then(() => cb(null))
        return new Promise((resolve, reject) => {
          const w: Waiter = { tab: id, cb, resolve, reject }
          if (!held.has(name) && !queues.get(name)?.length) return grant(name, w)
          const q = queues.get(name) ?? []
          q.push(w)
          queues.set(name, q)
          opts.signal?.addEventListener('abort', () => {
            const i = q.indexOf(w)
            if (i >= 0) q.splice(i, 1)
            reject(new DOMException('ожидание отменено', 'AbortError'))
          })
        })
      }) as LockManager['request']
      return {
        locks: { request },
        close() {
          closed.add(id)
          for (const q of queues.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i]!.tab === id) q.splice(i, 1)
          for (const [name, lease] of [...held]) if (lease.tab === id) release(name, lease)
        },
      }
    },
  }
}

/** Подставить LockManager вкладки в navigator.locks. Возвращает откат. */
export function setLocks(locks: Pick<LockManager, 'request'> | undefined): () => void {
  const nav = globalThis.navigator as object
  const own = Object.getOwnPropertyDescriptor(nav, 'locks')
  Object.defineProperty(nav, 'locks', { value: locks, configurable: true, writable: true })
  return () => {
    if (own) Object.defineProperty(nav, 'locks', own)
    else delete (nav as { locks?: unknown }).locks
  }
}
