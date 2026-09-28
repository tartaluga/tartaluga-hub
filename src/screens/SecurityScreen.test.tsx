// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Passkey, SecurityEvent, SessionInfo } from '../lib/api'
import type { StoredConflict } from '../lib/localdb'

// Экран рендерится по-настоящему (эффекты идут), данные отдаёт подменённый модуль api.
const server = vi.hoisted(() => ({
  thisDevice: false,
  passkeys: [] as unknown[],
  sessions: [] as unknown[],
  events: [] as unknown[],
}))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listPasskeys: vi.fn(async () => ({ thisDevice: server.thisDevice, passkeys: server.passkeys })),
  listSessions: vi.fn(async () => ({ sessions: server.sessions })),
  securityLog: vi.fn(async () => ({ events: server.events })),
  markSecuritySeen: vi.fn(async () => ({ ok: true })),
  logoutAll: vi.fn(async () => ({ ok: true })),
  deletePasskey: vi.fn(async () => ({ ok: true })),
  deleteSession: vi.fn(async () => ({ ok: true })),
}))
const mockSupported = vi.hoisted(() => vi.fn(() => true))
vi.mock('../lib/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/passkey')>()),
  passkeysSupported: () => mockSupported(),
  addPasskey: vi.fn(),
}))
const unsent = vi.hoisted(() => ({ conflicts: [] as unknown[] }))
vi.mock('../app/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/session')>()),
  unsentSnapshot: () => ({ edits: [], conflicts: [...unsent.conflicts] }),
}))

const { Security, ThisDeviceKey, THIS_DEVICE_STALE_HINT } = await import('./Security')
const { useSession } = await import('../app/session')
const { answerSignOut, useSignOutGuard } = await import('../app/signOutGuard')
const api = await import('../lib/api')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
const conflict = { branch: 'idea', path: 'projects/a.json', items: [{}] } as unknown as StoredConflict

let root: Root
let host: HTMLElement
const signOut = vi.fn(async () => undefined)

beforeEach(() => {
  Object.assign(server, { thisDevice: false, passkeys: [], sessions: [], events: [] })
  unsent.conflicts = []
  mockSupported.mockReturnValue(true)
  useSignOutGuard.setState({ ask: null })
  useSession.setState({ me: null, signOut })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  answerSignOut(false)
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

/** Рендер экрана; loaded=false — сервер не ответил, экран до загрузки. */
async function render(data: { thisDevice?: boolean; passkeys?: Passkey[]; sessions?: SessionInfo[]; events?: SecurityEvent[] } | null, canAdd = true) {
  mockSupported.mockReturnValue(canAdd)
  Object.assign(server, data ?? {})
  if (!data) vi.mocked(api.listPasskeys).mockReturnValueOnce(new Promise(() => undefined))
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Security />
      </MemoryRouter>,
    ),
  )
  await act(async () => undefined)
  return host.innerHTML
}

const button = (text: string) => {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text))
  if (!b) throw new Error(`нет кнопки «${text}»`)
  return b
}
/** В happy-dom нет window.confirm — подменяем своим. */
function stubConfirm(answer: boolean) {
  const fn = vi.fn((_text?: string) => answer)
  Object.defineProperty(window, 'confirm', { value: fn, configurable: true, writable: true })
  return fn
}
const click = (text: string) => act(async () => button(text).click())

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

  it('до загрузки кнопки «Добавить ключ» нет', async () => {
    expect(await render(null)).not.toContain('Добавить ключ')
  })

  it('у устройства нет ключа — главная кнопка «Добавить ключ»', async () => {
    const html = await render({ passkeys: [pk()] })
    expect(html).toContain('Добавить ключ')
    expect(html).not.toContain('Ключ этого устройства')
    expect(html).not.toContain('Добавить ещё ключ')
  })

  it('ключ есть — «Ключ этого устройства» и второстепенная «Добавить ещё ключ»', async () => {
    const html = await render({ thisDevice: true, passkeys: [pk({ thisDevice: true })] })
    expect(html).toContain('Ключ этого устройства')
    expect(html).toContain('Добавить ещё ключ')
    expect(html).not.toMatch(/Добавить ключ</)
  })

  it('браузер не умеет ключи, ключей нет — кнопок добавления нет', async () => {
    expect(await render({ passkeys: [] }, false)).not.toContain('Добавить')
  })

  it('браузер не умеет ключи, ключ есть — отметка остаётся, кнопок нет', async () => {
    const html = await render({ thisDevice: true, passkeys: [pk({ thisDevice: true })] }, false)
    expect(html).toContain('Ключ этого устройства')
    expect(html).not.toContain('Добавить')
  })

  it('метка «это устройство» только у ключа с thisDevice', async () => {
    const html = await render({ thisDevice: true, passkeys: [pk({ id: 'a', name: 'Ноутбук' }), pk({ id: 'b', name: 'Телефон', thisDevice: true })] })
    expect(html.match(/это устройство/g)).toHaveLength(1)
    expect(html).toMatch(/Телефон <span[^>]*>это устройство</)
  })
})

describe('Security: выход на другом устройстве', () => {
  it('кнопка «Выйти» есть у других входов, у текущего — нет', async () => {
    const html = await render({
      sessions: [sess({ id: '1'.repeat(64), current: true, device: 'Windows · Edge' }), sess({ id: '2'.repeat(64), device: 'Android · Chrome' })],
    })
    expect(html).toContain('aria-label="Выйти на устройстве Android · Chrome"')
    expect(html).not.toContain('Выйти на устройстве Windows · Edge')
    expect(html.match(/aria-label="Выйти на устройстве/g)).toHaveLength(1)
  })

  it('один текущий вход — ни одной кнопки «Выйти» в списке', async () => {
    expect(await render({ sessions: [sess({ current: true })] })).not.toContain('Выйти на устройстве')
  })

  it('журнал: session_revoked — понятный текст и предупреждение', async () => {
    const html = await render({ events: [{ at: 0, event: 'session_revoked', method: 'github', device: 'Windows · Edge', detail: 'Android · Chrome', seen: false }] })
    expect(html).toMatch(/data-warn="true"[^>]*><div><div>Завершён вход на устройстве «Android · Chrome»/)
  })

  it('имя устройства из базы экранируется', async () => {
    await render({ sessions: [sess({ device: '<img src=x onerror=alert(1)>' })] })
    // Сериализация happy-dom не экранирует «<» в тексте, поэтому проверяем DOM: тега нет, строка — текстом.
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('Security: заголовки блоков', () => {
  it('у каждого блока, включая «Журнал», есть иконка перед названием', async () => {
    const html = await render({ passkeys: [pk()] })
    const heads = html.match(/<h2[^>]*>.*?<\/h2>/g) ?? []
    expect(heads.some((h) => h.includes('Журнал'))).toBe(true)
    for (const h of heads) expect(h).toMatch(/^<h2[^>]*><svg[^>]*aria-hidden="true"/)
  })
})

describe('Security: выход идёт через страж', () => {
  it('«Выйти на этом устройстве» без неотправленного — выход сразу', async () => {
    await render({})
    await click('Выйти на этом устройстве')
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('«Выйти на этом устройстве» с конфликтом — ждёт «Стереть и выйти»', async () => {
    unsent.conflicts = [conflict]
    await render({})
    await click('Выйти на этом устройстве')
    expect(useSignOutGuard.getState().ask?.scope).toBe('device')
    expect(signOut).not.toHaveBeenCalled()
    await act(async () => answerSignOut(true))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('«Выйти везде» с конфликтом и «Отмена» — ни сервера, ни стирания', async () => {
    unsent.conflicts = [conflict]
    const confirm = stubConfirm(true)
    await render({})
    await click('Выйти везде')
    expect(useSignOutGuard.getState().ask?.scope).toBe('everywhere')
    await act(async () => answerSignOut(false))
    expect(api.logoutAll).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('«Выйти везде» с конфликтом и «Стереть и выйти» — сервер, потом выход, без второго вопроса', async () => {
    unsent.conflicts = [conflict]
    const confirm = stubConfirm(true)
    await render({})
    await click('Выйти везде')
    await act(async () => answerSignOut(true))
    await act(async () => undefined)
    expect(api.logoutAll).toHaveBeenCalledOnce()
    expect(signOut).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('«Выйти везде» без неотправленного — прежний confirm; отказ — ничего', async () => {
    const confirm = stubConfirm(false)
    await render({})
    await click('Выйти везде')
    expect(confirm).toHaveBeenCalledOnce()
    expect(useSignOutGuard.getState().ask).toBeNull()
    expect(api.logoutAll).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await click('Выйти везде')
    await act(async () => undefined)
    expect(api.logoutAll).toHaveBeenCalledOnce()
    expect(signOut).toHaveBeenCalledOnce()
  })
})
