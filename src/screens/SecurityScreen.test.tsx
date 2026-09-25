import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { Passkey, SecurityEvent, SessionInfo } from '../lib/api'

// Серверный рендер не запускает эффекты, поэтому загруженные данные подкладываем в первый useState(null) экрана.
const seed: { data: unknown[] } = { data: [] }
vi.mock('react', async (importOriginal) => {
  const React = await importOriginal<typeof import('react')>()
  const useState = ((init: unknown) => React.useState(init === null && seed.data.length ? seed.data.shift() : init)) as typeof React.useState
  return { ...React, default: { ...React, useState }, useState }
})
const mockSupported = vi.fn(() => true)
vi.mock('../lib/passkey', () => ({ passkeysSupported: () => mockSupported(), addPasskey: vi.fn() }))

const { Security } = await import('./Security')

const pk = (over: Partial<Passkey> = {}): Passkey => ({ id: 'k1', name: 'Pixel', createdAt: 0, lastUsedAt: null, thisDevice: false, ...over })
const sess = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'a'.repeat(64),
  current: false,
  device: 'Android · Chrome',
  method: 'github',
  createdAt: 0,
  lastUsedAt: 0,
  ...over,
})

function render(data: { thisDevice?: boolean; passkeys?: Passkey[]; sessions?: SessionInfo[]; events?: SecurityEvent[] } | null, canAdd = true) {
  mockSupported.mockReturnValue(canAdd)
  seed.data = data ? [{ thisDevice: false, passkeys: [], sessions: [], events: [], ...data }] : []
  return renderToStaticMarkup(
    <MemoryRouter>
      <Security />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  seed.data = []
})

describe('Security: ключ этого устройства', () => {
  it('до загрузки кнопки «Добавить ключ» нет', () => {
    expect(render(null)).not.toContain('Добавить ключ')
  })

  it('у устройства нет ключа — главная кнопка «Добавить ключ»', () => {
    const html = render({ passkeys: [pk()] })
    expect(html).toContain('Добавить ключ')
    expect(html).not.toContain('Ключ этого устройства')
    expect(html).not.toContain('Добавить ещё ключ')
  })

  it('ключ есть — «Ключ этого устройства» и второстепенная «Добавить ещё ключ»', () => {
    const html = render({ thisDevice: true, passkeys: [pk({ thisDevice: true })] })
    expect(html).toContain('Ключ этого устройства')
    expect(html).toContain('Добавить ещё ключ')
    expect(html).not.toMatch(/Добавить ключ</)
  })

  it('браузер не умеет ключи — кнопок добавления нет, отметка остаётся', () => {
    expect(render({ passkeys: [] }, false)).not.toContain('Добавить')
    const html = render({ thisDevice: true, passkeys: [pk({ thisDevice: true })] }, false)
    expect(html).toContain('Ключ этого устройства')
    expect(html).not.toContain('Добавить')
  })

  it('метка «это устройство» только у ключа с thisDevice', () => {
    const html = render({ thisDevice: true, passkeys: [pk({ id: 'a', name: 'Ноутбук' }), pk({ id: 'b', name: 'Телефон', thisDevice: true })] })
    expect(html.match(/это устройство/g)).toHaveLength(1)
    expect(html).toMatch(/Телефон <span[^>]*>это устройство</)
  })
})

describe('Security: выход на другом устройстве', () => {
  it('кнопка «Выйти» есть у других входов, у текущего — нет', () => {
    const html = render({
      sessions: [sess({ id: '1'.repeat(64), current: true, device: 'Windows · Edge' }), sess({ id: '2'.repeat(64), device: 'Android · Chrome' })],
    })
    expect(html).toContain('aria-label="Выйти на устройстве Android · Chrome"')
    expect(html).not.toContain('Выйти на устройстве Windows · Edge')
    expect(html.match(/aria-label="Выйти на устройстве/g)).toHaveLength(1)
  })

  it('один текущий вход — ни одной кнопки «Выйти» в списке', () => {
    expect(render({ sessions: [sess({ current: true })] })).not.toContain('Выйти на устройстве')
  })

  it('журнал: session_revoked — понятный текст и предупреждение', () => {
    const html = render({ events: [{ at: 0, event: 'session_revoked', method: 'github', device: 'Windows · Edge', detail: 'Android · Chrome', seen: false }] })
    expect(html).toMatch(/data-warn="true"[^>]*><div><div>Завершён вход на устройстве «Android · Chrome»/)
  })

  it('имя устройства из базы экранируется', () => {
    const html = render({ sessions: [sess({ device: '<img src=x onerror=alert(1)>' })] })
    expect(html).not.toContain('<img src=x')
  })
})
