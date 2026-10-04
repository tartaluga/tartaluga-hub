// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queued = vi.hoisted(() => ({ value: false }))
const mocks = vi.hoisted(() => ({ saveCover: vi.fn(), renderCover: vi.fn() }))
vi.mock('../app/session', async (orig) => ({ ...(await orig<typeof import('../app/session')>()), hasQueued: () => queued.value }))
vi.mock('../data/coverEdit', async (orig) => ({ ...(await orig<typeof import('../data/coverEdit')>()), saveCover: mocks.saveCover }))
vi.mock('../lib/coverFrame', async (orig) => ({ ...(await orig<typeof import('../lib/coverFrame')>()), renderCover: mocks.renderCover }))

import { useSession } from '../app/session'
import { ApiError } from '../lib/api'
import { CoverEditor } from './CoverEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  queued.value = false
  mocks.saveCover.mockReset()
  mocks.renderCover.mockReset().mockResolvedValue({ bytes: new Uint8Array([1]), ext: 'webp' })
  useSession.setState({ readOnly: false, queued: 0, branch: 'main' })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = (hasOwn = false) => act(async () => root.render(<CoverEditor slug="bot" hasOwn={hasOwn} />))
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined

async function choose(file: File) {
  const input = host.querySelector('input[type=file]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
const png = () => new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })

describe('CoverEditor', () => {
  it('кнопка «Убрать» только если своя обложка есть', async () => {
    await render(false)
    expect(button('Сменить обложку')).toBeTruthy()
    expect(button('Убрать обложку')).toBeUndefined()
    await render(true)
    expect(button('Убрать обложку')).toBeTruthy()
  })

  it('режим просмотра — кнопок нет', async () => {
    useSession.setState({ readOnly: true })
    await render(true)
    expect(host.querySelector('button')).toBeNull()
  })

  it('офлайн — кнопки неактивны с подсказкой', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await render(true)
    expect(button('Сменить обложку')!.disabled).toBe(true)
    expect(button('Убрать обложку')!.disabled).toBe(true)
    expect(host.textContent).toContain('Обложку можно сменить только онлайн')
  })

  it('есть неотправленная правка проекта — кнопки неактивны с подсказкой', async () => {
    queued.value = true
    useSession.setState({ queued: 1 })
    await render(false)
    expect(button('Сменить обложку')!.disabled).toBe(true)
    expect(host.textContent).toContain('Сначала дождитесь отправки правок проекта')
  })

  it('не картинка отклоняется сразу, диалог не открывается', async () => {
    await render()
    await choose(new File(['x'], 'a.html', { type: 'text/html' }))
    expect(host.textContent).toContain('Нужна картинка')
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('выбор файла открывает предпросмотр с ползунком; сохранение отправляет кадр', async () => {
    await render()
    await choose(png())
    const slider = document.querySelector('input[type=range]') as HTMLInputElement
    expect(slider).toBeTruthy()
    expect(document.querySelector('dialog')?.textContent).toContain('Положение кадра')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '20')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocks.saveCover.mockResolvedValue(undefined)
    await act(async () => button('Сохранить')!.click())
    expect(mocks.renderCover).toHaveBeenCalledWith(expect.any(File), 0.2)
    expect(mocks.saveCover).toHaveBeenCalledWith('bot', { bytes: expect.any(Uint8Array), ext: 'webp' })
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('409: диалог и выбранный кадр остаются, повтор доступен', async () => {
    await render()
    await choose(png())
    mocks.saveCover.mockRejectedValueOnce(new ApiError(409, 'conflict', 'x')).mockResolvedValueOnce(undefined)
    await act(async () => button('Сохранить')!.click())
    expect(document.querySelector('dialog')?.textContent).toContain('ещё раз')
    expect(button('Сохранить')!.disabled).toBe(false)
    await act(async () => button('Сохранить')!.click())
    expect(mocks.saveCover).toHaveBeenCalledTimes(2)
    expect(mocks.renderCover).toHaveBeenLastCalledWith(expect.any(File), 0.5)
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('ошибка сервера показана рядом с кнопкой при удалении', async () => {
    window.confirm = vi.fn(() => true)
    mocks.saveCover.mockRejectedValue(new ApiError(500, 'server', 'Сервер упал'))
    await render(true)
    await act(async () => button('Убрать обложку')!.click())
    expect(mocks.saveCover).toHaveBeenCalledWith('bot', null)
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Сервер упал')
  })

  it('«Отмена» закрывает диалог без записи', async () => {
    await render()
    await choose(png())
    await act(async () => button('Отмена')!.click())
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.saveCover).not.toHaveBeenCalled()
  })
})
