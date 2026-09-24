import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Поддержку ключей в node не определить: подменяем, чтобы проверить оба вида экрана.
const mockSupported = vi.fn(() => true)
vi.mock('../lib/passkey', () => ({
  passkeysSupported: () => mockSupported(),
  passkeyErrorText: () => '',
  signInWithPasskey: vi.fn(),
}))

async function render(canPasskey: boolean, reason?: string) {
  mockSupported.mockReturnValue(canPasskey)
  const { Login } = await import('./Login')
  return renderToStaticMarkup(<Login reason={reason} />)
}

describe('Login: только кнопки входа', () => {
  it.each([true, false])('без пояснений про GitHub и репозиторий (ключ поддержан: %s)', async (canPasskey) => {
    const html = await render(canPasskey)
    expect(html).not.toMatch(/репозитор/i)
    expect(html).not.toContain('Первый вход')
    expect(html).not.toContain('не умеет')
    expect(html).not.toMatch(/<p[ >]/)
    expect(html).toContain('Войти через GitHub')
  })

  it('кнопка ключа — только если браузер умеет ключи', async () => {
    expect(await render(true)).toContain('Войти по ключу')
    expect(await render(false)).not.toContain('Войти по ключу')
  })

  it('ошибку входа показывает', async () => {
    const html = await render(true, 'Сессия кончилась')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Сессия кончилась')
  })
})
