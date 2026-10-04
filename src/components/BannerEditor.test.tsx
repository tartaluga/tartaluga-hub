// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queued = vi.hoisted(() => ({ value: false }))
const bannerUrl = vi.hoisted(() => ({ value: null as string | null }))
const mocks = vi.hoisted(() => ({ saveBanner: vi.fn(), renderBanner: vi.fn() }))
vi.mock('../app/session', async (orig) => ({ ...(await orig<typeof import('../app/session')>()), hasQueued: () => queued.value }))
vi.mock('../data/coverEdit', async (orig) => ({ ...(await orig<typeof import('../data/coverEdit')>()), saveBanner: mocks.saveBanner }))
vi.mock('../lib/coverFrame', async (orig) => ({ ...(await orig<typeof import('../lib/coverFrame')>()), renderBanner: mocks.renderBanner }))
vi.mock('../app/useCoverUrl', () => ({ useBannerUrl: () => bannerUrl.value }))

import { useSession } from '../app/session'
import { ApiError } from '../lib/api'
import { Banner } from './Banner'
import { BannerEditor } from './BannerEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  queued.value = false
  bannerUrl.value = null
  mocks.saveBanner.mockReset()
  mocks.renderBanner.mockReset().mockResolvedValue({ bytes: new Uint8Array([1]), ext: 'webp' })
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

const render = (hasOwn = false) => act(async () => root.render(<BannerEditor slug="bot" hasOwn={hasOwn} />))
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const png = () => new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })

async function choose(file: File) {
  const input = host.querySelector('input[type=file]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
async function setRange(index: number, value: string) {
  const slider = document.querySelectorAll('input[type=range]')[index] as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, value)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('BannerEditor', () => {
  it('«Поставить шапку», а «Сменить / Убрать» — только если своя шапка есть', async () => {
    await render(false)
    expect(button('Поставить шапку')).toBeTruthy()
    expect(button('Убрать шапку')).toBeUndefined()
    await render(true)
    expect(button('Сменить шапку')).toBeTruthy()
    expect(button('Убрать шапку')).toBeTruthy()
  })

  it('режим просмотра — кнопок нет', async () => {
    useSession.setState({ readOnly: true })
    await render(true)
    expect(host.querySelector('button')).toBeNull()
  })

  it('офлайн — кнопки неактивны с подсказкой', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await render(true)
    expect(button('Сменить шапку')!.disabled).toBe(true)
    expect(button('Убрать шапку')!.disabled).toBe(true)
    expect(button('Сменить шапку')!.title).toBe('Шапку можно сменить только онлайн')
  })

  it('есть неотправленная правка проекта — кнопки неактивны', async () => {
    queued.value = true
    useSession.setState({ queued: 1 })
    await render(false)
    expect(button('Поставить шапку')!.disabled).toBe(true)
    expect(button('Поставить шапку')!.title).toContain('Сначала дождитесь отправки')
  })

  it('не картинка отклоняется сразу, диалог не открывается', async () => {
    await render()
    await choose(new File(['x'], 'a.html', { type: 'text/html' }))
    expect(host.textContent).toContain('Нужна картинка')
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('диалог: три ползунка, сохранение отправляет выбранный кадр', async () => {
    await render()
    await choose(png())
    expect(document.querySelectorAll('input[type=range]')).toHaveLength(3)
    expect(document.querySelector('dialog')?.textContent).toContain('5:2')
    await setRange(0, '20')
    await setRange(1, '70')
    await setRange(2, '200')
    mocks.saveBanner.mockResolvedValue(undefined)
    await act(async () => button('Сохранить шапку')!.click())
    expect(mocks.renderBanner).toHaveBeenCalledWith(expect.any(File), { x: 0.2, y: 0.7, zoom: 2 })
    expect(mocks.saveBanner).toHaveBeenCalledWith('bot', { bytes: expect.any(Uint8Array), ext: 'webp' })
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('409: диалог и кадр остаются, повтор доступен', async () => {
    await render()
    await choose(png())
    await setRange(0, '10')
    mocks.saveBanner.mockRejectedValueOnce(new ApiError(409, 'conflict', 'x')).mockResolvedValueOnce(undefined)
    await act(async () => button('Сохранить шапку')!.click())
    expect(document.querySelector('dialog')?.textContent).toContain('ещё раз')
    await act(async () => button('Сохранить шапку')!.click())
    expect(mocks.saveBanner).toHaveBeenCalledTimes(2)
    expect(mocks.renderBanner).toHaveBeenLastCalledWith(expect.any(File), { x: 0.1, y: 0.5, zoom: 1 })
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('«Убрать шапку» с подтверждением; ошибка сервера показана рядом', async () => {
    window.confirm = vi.fn(() => true)
    mocks.saveBanner.mockRejectedValue(new ApiError(500, 'server', 'Сервер упал'))
    await render(true)
    await act(async () => button('Убрать шапку')!.click())
    expect(mocks.saveBanner).toHaveBeenCalledWith('bot', null)
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Сервер упал')
  })

  it('отказ в подтверждении — ничего не пишется; «Отмена» закрывает диалог без записи', async () => {
    window.confirm = vi.fn(() => false)
    await render(true)
    await act(async () => button('Убрать шапку')!.click())
    expect(mocks.saveBanner).not.toHaveBeenCalled()
    await choose(png())
    await act(async () => button('Отмена')!.click())
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.saveBanner).not.toHaveBeenCalled()
  })
})

describe('Banner', () => {
  it('нет шапки — рисует запасной вариант (обложку)', () => {
    const html = renderToStaticMarkup(<Banner slug="a"><b>cover</b></Banner>)
    expect(html).toBe('<b>cover</b>')
  })
  it('есть шапка — img без обложки, декоративный', () => {
    bannerUrl.value = 'blob:http://127.0.0.1/b'
    const html = renderToStaticMarkup(<Banner slug="a"><b>cover</b></Banner>)
    expect(html).toMatch(/<img[^>]*src="blob:http:\/\/127\.0\.0\.1\/b"/)
    expect(html).toContain('alt=""')
    expect(html).not.toContain('cover</b>')
  })
})
