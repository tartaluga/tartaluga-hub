import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Мок virtual:pwa-register/react: сам модуль существует только благодаря vite-plugin-pwa
// и в реальности трогает navigator.serviceWorker — в тестах это ни к чему.
// Имя обязано начинаться с "mock": так требует hoisting vi.mock (переносится в начало файла).
const mockUseRegisterSW = vi.fn()
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (...args: unknown[]) => mockUseRegisterSW(...args),
}))

type RegisteredCallbacks = { onRegisteredSW?: (url: string, reg?: ServiceWorkerRegistration) => void }

function stubHook(needRefresh: boolean, setNeedRefresh = vi.fn()) {
  let captured: RegisteredCallbacks = {}
  mockUseRegisterSW.mockImplementation((opts: RegisteredCallbacks) => {
    captured = opts ?? {}
    return {
      needRefresh: [needRefresh, setNeedRefresh],
      updateServiceWorker: vi.fn(),
    }
  })
  return { getOptions: () => captured, setNeedRefresh }
}

describe('UpdateBanner: плашка «Обновить»', () => {
  beforeEach(() => {
    mockUseRegisterSW.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('когда новой версии нет — ничего не рендерит', async () => {
    stubHook(false)
    const { UpdateBanner } = await import('./UpdateBanner')
    expect(renderToStaticMarkup(<UpdateBanner />)).toBe('')
  })

  it('когда есть новая версия — показывает текст и обе кнопки', async () => {
    stubHook(true)
    const { UpdateBanner } = await import('./UpdateBanner')
    const html = renderToStaticMarkup(<UpdateBanner />)
    expect(html).toContain('Доступна новая версия хаба')
    expect(html).toContain('Обновить')
    expect(html).toContain('Позже')
  })

  it('после регистрации service worker проверяет обновления раз в час', async () => {
    const { getOptions } = stubHook(false)
    const { UpdateBanner } = await import('./UpdateBanner')
    renderToStaticMarkup(<UpdateBanner />)

    const reg = { update: vi.fn().mockResolvedValue(undefined) } as unknown as ServiceWorkerRegistration
    getOptions().onRegisteredSW?.('/sw.js', reg)

    expect(reg.update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(2)
  })

  it('без reg (регистрация не удалась) — таймер не заводит и не падает', async () => {
    const { getOptions } = stubHook(false)
    const { UpdateBanner } = await import('./UpdateBanner')
    renderToStaticMarkup(<UpdateBanner />)

    expect(() => getOptions().onRegisteredSW?.('/sw.js', undefined)).not.toThrow()
  })

  it('повторная регистрация не плодит параллельные таймеры: старый гасится', async () => {
    const { getOptions } = stubHook(false)
    const { UpdateBanner } = await import('./UpdateBanner')
    renderToStaticMarkup(<UpdateBanner />)

    const reg1 = { update: vi.fn().mockResolvedValue(undefined) } as unknown as ServiceWorkerRegistration
    const reg2 = { update: vi.fn().mockResolvedValue(undefined) } as unknown as ServiceWorkerRegistration
    getOptions().onRegisteredSW?.('/sw.js', reg1)
    expect(vi.getTimerCount()).toBe(1)

    getOptions().onRegisteredSW?.('/sw.js', reg2)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(reg1.update).not.toHaveBeenCalled()
    expect(reg2.update).toHaveBeenCalledTimes(1)
  })
})
