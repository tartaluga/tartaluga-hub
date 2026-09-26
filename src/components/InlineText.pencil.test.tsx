// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineText } from './InlineText'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let onSave: ReturnType<typeof vi.fn<(t: string) => Promise<string | null>>>

async function render(props: { readOnly?: boolean; trigger?: 'row' | 'pencil' } = {}) {
  await act(async () =>
    root.render(<InlineText value="Бот" placeholder="Без названия" label="Название" maxLength={100} trigger="pencil" onSave={onSave} {...props} />),
  )
}

const pencil = () => host.querySelector<HTMLButtonElement>('[aria-label="Изменить название"]')
const field = () => host.querySelector<HTMLInputElement>('input')

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(el: Element, k: string) {
  await act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onSave = vi.fn(async () => null)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('InlineText trigger="pencil"', () => {
  it('нажатие на текст поле не открывает; текст — не кнопка', async () => {
    await render()
    const text = [...host.querySelectorAll('span')].find((s) => s.textContent === 'Бот')!
    expect(text.closest('button')).toBeNull()
    await act(async () => text.click())
    expect(field()).toBeNull()
  })

  it('карандаш — настоящая кнопка с подписью и открывает поле', async () => {
    await render()
    const p = pencil()!
    expect(p.tagName).toBe('BUTTON')
    expect(p.type).toBe('button')
    await act(async () => p.click())
    expect(field()).not.toBeNull()
    expect(document.activeElement).toBe(field())
  })

  it('Enter сохраняет, фокус возвращается на карандаш', async () => {
    await render()
    await act(async () => pencil()!.click())
    await type(field()!, 'Бот 2')
    await key(field()!, 'Enter')
    expect(onSave).toHaveBeenCalledWith('Бот 2')
    expect(field()).toBeNull()
    expect(document.activeElement).toBe(pencil())
  })

  it('Esc отменяет без сохранения, фокус возвращается на карандаш', async () => {
    await render()
    await act(async () => pencil()!.click())
    await type(field()!, 'другое')
    await key(field()!, 'Escape')
    expect(onSave).not.toHaveBeenCalled()
    expect(field()).toBeNull()
    expect(document.activeElement).toBe(pencil())
  })

  it('ошибка сохранения — поле остаётся открытым с введённым текстом', async () => {
    onSave.mockResolvedValueOnce('Нет сети')
    await render()
    await act(async () => pencil()!.click())
    await type(field()!, 'Бот 2')
    await key(field()!, 'Enter')
    expect(field()!.value).toBe('Бот 2')
    expect(host.textContent).toContain('Нет сети')
  })

  it('только чтение — карандаша нет', async () => {
    await render({ readOnly: true })
    expect(pencil()).toBeNull()
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('Бот')
  })

  it('по умолчанию (row) поле по-прежнему открывается нажатием на текст', async () => {
    await render({ trigger: 'row' })
    expect(pencil()).toBeNull()
    await act(async () => host.querySelector('button')!.click())
    expect(field()).not.toBeNull()
  })
})
