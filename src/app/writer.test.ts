// Пишущая вкладка (ADR-013): одна вкладка держит лок, остальные ждут и по очереди становятся пишущими.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLockHub, setLocks } from '../test/fakeLocks'

type WriterModule = typeof import('./writer')

const restores: (() => void)[] = []
afterEach(() => {
  for (const fn of restores.splice(0)) fn()
  vi.unstubAllGlobals()
})

/** Новая вкладка: свой экземпляр модуля и свой LockManager на общей «машине». */
async function tab(locks: Pick<LockManager, 'request'> | undefined): Promise<WriterModule> {
  vi.resetModules()
  const m = await import('./writer')
  const restore = setLocks(locks)
  restores.push(restore)
  await m.claimWriter()
  restore()
  return m
}

describe('пишущая вкладка', () => {
  it('первая вкладка пишет, вторая — только просмотр; ответ повторяемый', async () => {
    const hub = fakeLockHub()
    const a = await tab(hub.tab().locks)
    const b = await tab(hub.tab().locks)
    expect(a.isWriter()).toBe(true)
    expect(b.isWriter()).toBe(false)
    await expect(a.claimWriter()).resolves.toBe(true)
    await expect(b.claimWriter()).resolves.toBe(false)
  })

  it('пишущая закрылась — ждущая становится пишущей и сообщает об этом; третья ждёт следующей', async () => {
    const hub = fakeLockHub()
    const ta = hub.tab()
    const tb = hub.tab()
    await tab(ta.locks)
    const b = await tab(tb.locks)
    const c = await tab(hub.tab().locks)
    const promotedB = vi.fn()
    const promotedC = vi.fn()
    b.onBecameWriter(promotedB)
    c.onBecameWriter(promotedC)
    ta.close()
    await vi.waitFor(() => expect(promotedB).toHaveBeenCalledOnce())
    expect(b.isWriter()).toBe(true)
    expect(c.isWriter()).toBe(false)
    expect(promotedC).not.toHaveBeenCalled()
    tb.close()
    await vi.waitFor(() => expect(promotedC).toHaveBeenCalledOnce())
    expect(c.isWriter()).toBe(true)
  })

  it('отписка: закрытие пишущей больше не зовёт обработчик', async () => {
    const hub = fakeLockHub()
    const ta = hub.tab()
    await tab(ta.locks)
    const b = await tab(hub.tab().locks)
    const fn = vi.fn()
    b.onBecameWriter(fn)()
    ta.close()
    await vi.waitFor(() => expect(b.isWriter()).toBe(true))
    expect(fn).not.toHaveBeenCalled()
  })

  it('без Web Locks вкладка пишет, как одна', async () => {
    const m = await tab(undefined)
    expect(m.isWriter()).toBe(true)
  })

  it('браузер отказал в Web Locks — вкладка пишет, как одна', async () => {
    const m = await tab({ request: (() => Promise.reject(new DOMException('нет', 'SecurityError'))) as LockManager['request'] })
    expect(m.isWriter()).toBe(true)
  })

  it('Web Locks бросает синхронно — вкладка пишет, как одна, старт не падает', async () => {
    const m = await tab({
      request: (() => {
        throw new DOMException('нет', 'SecurityError')
      }) as LockManager['request'],
    })
    expect(m.isWriter()).toBe(true)
    expect(m.isReader()).toBe(false)
  })

  it('isReader: до спроса лока — false, у вкладки просмотра — true', async () => {
    vi.resetModules()
    const fresh = await import('./writer')
    expect(fresh.isReader()).toBe(false)
    const hub = fakeLockHub()
    await tab(hub.tab().locks)
    const b = await tab(hub.tab().locks)
    expect(b.isReader()).toBe(true)
  })

  it('уступить запись: просящая (вставшая в конец очереди) получает лок раньше прочих, уступившая ждёт за ней', async () => {
    const hub = fakeLockHub()
    const a = await tab(hub.tab().locks)
    const c = await tab(hub.tab().locks) // ждёт первой
    const b = await tab(hub.tab().locks) // просит «Писать здесь»
    const demoted = vi.fn()
    a.onBecameReader(demoted)
    c.requeueWriter() // остальные вкладки просмотра пропускают просящую вперёд
    a.yieldWriter()
    expect(demoted).toHaveBeenCalledOnce()
    expect(a.isWriter()).toBe(false)
    await vi.waitFor(() => expect(b.isWriter()).toBe(true))
    expect(c.isWriter()).toBe(false)
    expect(a.isReader()).toBe(true)
  })

  it('resetWriter отпускает лок: следующая вкладка сразу пишет', async () => {
    const hub = fakeLockHub()
    const a = await tab(hub.tab().locks)
    a.resetWriter()
    await vi.waitFor(() => expect(hub.holder('hub-writer')).toBeUndefined())
    const b = await tab(hub.tab().locks)
    expect(b.isWriter()).toBe(true)
  })
})
