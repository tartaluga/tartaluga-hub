// @vitest-environment happy-dom
// Плашка вкладки просмотра (ADR-013): видна только в просмотре, запирает поля; стала пишущей — плашки нет, поля живые.
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READ_ONLY, useSession } from '../app/session'
import { ReadOnlyBanner, TAKEOVER_ASKING, TAKEOVER_NO_ANSWER } from './ReadOnlyBanner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useSession.setState({ readOnly: false, takeover: null })
})

describe('ReadOnlyBanner', () => {
  it('пишущая вкладка — плашки нет, поля принимают ввод', () => {
    act(() => root.render(<ReadOnlyBanner />))
    expect(host.textContent).toBe('')
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(input.readOnly).toBe(false)
  })

  it('просмотр — плашка с объяснением, поля заперты; стала пишущей — плашка уходит, поля снова живые', () => {
    useSession.setState({ readOnly: true })
    act(() => root.render(<ReadOnlyBanner />))
    expect(host.querySelector('[role="status"]')?.textContent).toContain(READ_ONLY)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(input.readOnly).toBe(true)
    act(() => useSession.setState({ readOnly: false }))
    expect(host.textContent).toBe('')
    expect(input.readOnly).toBe(false)
  })

  it('«Писать здесь» просит запись; пока ждём — кнопка неактивна; нет ответа — «закрой её»', () => {
    const requestWrite = vi.fn()
    useSession.setState({ readOnly: true, requestWrite })
    act(() => root.render(<ReadOnlyBanner />))
    const button = host.querySelector('button')!
    expect(button.textContent).toBe('Писать здесь')
    act(() => button.click())
    expect(requestWrite).toHaveBeenCalledOnce()
    act(() => useSession.setState({ takeover: 'asking' }))
    expect(host.textContent).toContain(TAKEOVER_ASKING)
    expect(button.disabled).toBe(true)
    act(() => useSession.setState({ takeover: 'noAnswer' }))
    expect(host.textContent).toContain(TAKEOVER_NO_ANSWER)
    expect(button.disabled).toBe(false)
  })
})
