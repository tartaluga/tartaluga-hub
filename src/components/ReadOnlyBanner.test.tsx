// @vitest-environment happy-dom
// Плашка вкладки просмотра (ADR-013): видна только в просмотре, запирает поля; стала пишущей — плашки нет, поля живые.
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { READ_ONLY, useSession } from '../app/session'
import { ReadOnlyBanner } from './ReadOnlyBanner'

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
  useSession.setState({ readOnly: false })
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
    expect(host.querySelector('[role="status"]')?.textContent).toBe(READ_ONLY)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(input.readOnly).toBe(true)
    act(() => useSession.setState({ readOnly: false }))
    expect(host.textContent).toBe('')
    expect(input.readOnly).toBe(false)
  })
})
