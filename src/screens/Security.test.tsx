import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThisDeviceKey, THIS_DEVICE_STALE_HINT } from './Security'

vi.mock('../lib/passkey', () => ({ addPasskey: vi.fn(), passkeysSupported: () => true }))

describe('Security: ключ этого устройства', () => {
  it('рядом с «Ключ этого устройства» — подсказка про ключ, удалённый из менеджера паролей', () => {
    const html = renderToStaticMarkup(<ThisDeviceKey canAdd busy={false} onAdd={() => {}} />)
    expect(html).toContain('Ключ этого устройства')
    expect(html).toContain(THIS_DEVICE_STALE_HINT)
    expect(THIS_DEVICE_STALE_HINT).toMatch(/менеджера паролей.*удали его здесь и добавь заново/)
    expect(html).toContain('Добавить ещё ключ')
  })

  it('подсказка есть и без кнопки «Добавить ещё ключ»', () => {
    const html = renderToStaticMarkup(<ThisDeviceKey canAdd={false} busy={false} onAdd={() => {}} />)
    expect(html).toContain(THIS_DEVICE_STALE_HINT)
    expect(html).not.toContain('Добавить ещё ключ')
  })
})
