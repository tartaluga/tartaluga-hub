// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOCK_VAR, trackDockHeight } from './dockHeight'

afterEach(() => vi.unstubAllGlobals())

describe('trackDockHeight', () => {
  it('ставит высоту дока в переменную, при изменении обновляет, при снятии убирает', () => {
    let notify = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { notify = cb } observe() {} disconnect = disconnect })
    const el = document.createElement('div')
    Object.defineProperty(el, 'offsetHeight', { value: 62, configurable: true })
    const cleanup = trackDockHeight(el) as () => void
    expect(document.documentElement.style.getPropertyValue(DOCK_VAR)).toBe('62px')
    Object.defineProperty(el, 'offsetHeight', { value: 106, configurable: true })
    notify()
    expect(document.documentElement.style.getPropertyValue(DOCK_VAR)).toBe('106px')
    cleanup()
    expect(disconnect).toHaveBeenCalled()
    expect(document.documentElement.style.getPropertyValue(DOCK_VAR)).toBe('')
  })

  it('без элемента ничего не делает', () => {
    expect(trackDockHeight(null)).toBeUndefined()
  })
})
