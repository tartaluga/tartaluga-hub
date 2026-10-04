import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  queued: { value: false },
  commit: vi.fn(),
  applyWrite: vi.fn(async (..._a: unknown[]) => undefined),
  refresh: vi.fn(async () => undefined),
  put: vi.fn(async (..._a: unknown[]) => undefined),
  saveIndex: vi.fn(),
}))
vi.mock('../app/session', () => {
  const useSession = Object.assign(() => undefined, {
    getState: () => h.state as never,
    setState: (p: Record<string, unknown>) => Object.assign(h.state, p),
  })
  return {
    useSession,
    onlyWriter: (fn: unknown) => fn,
    hasQueued: () => h.queued.value,
    applyWrite: h.applyWrite,
    writeRemote: () => ({ commit: h.commit, putFile: vi.fn() }),
  }
})
vi.mock('../lib/localdb', () => ({ deviceEpoch: () => 1, putCoverIfCurrent: h.put, saveCoverIndex: h.saveIndex }))

import { saveBanner } from './coverEdit'

const webp = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), ext: 'webp' as const }
const projText = JSON.stringify({ schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', createdAt: '2026-09-01T10:00:00+03:00', updatedAt: '2026-09-01T10:00:00+03:00' })

beforeEach(() => {
  vi.clearAllMocks()
  h.queued.value = false
  Object.assign(h.state, {
    branch: 'main',
    refresh: h.refresh,
    tree: { head: 'h1', paths: ['projects/bot.json', 'banners/bot.jpg'], covers: { 'banners/bot.jpg': 'old', 'covers/bot.webp': 'cov' } },
    files: [{ path: 'projects/bot.json', sha: 's', text: projText }],
  })
  h.commit.mockResolvedValue({ head: 'h2', shas: { 'banners/bot.webp': 'newsha', 'projects/bot.json': 'psha' } })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

describe('saveBanner', () => {
  it('офлайн: сеть не трогаем, подсказка про шапку', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await expect(saveBanner('bot', webp)).rejects.toMatchObject({ status: 0, message: 'Шапку можно сменить только онлайн' })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('есть правка в очереди: 423, без коммита', async () => {
    h.queued.value = true
    await expect(saveBanner('bot', webp)).rejects.toMatchObject({ status: 423 })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('байты не совпадают с расширением: отказ до коммита', async () => {
    await expect(saveBanner('bot', { bytes: webp.bytes, ext: 'jpg' })).rejects.toMatchObject({ status: 422 })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('успех: один атомарный коммит с файлом шапки и проектом, индекс и кэш обновлены, обложка цела', async () => {
    await saveBanner('bot', webp)
    expect(h.commit).toHaveBeenCalledTimes(1)
    const [, changes, head, msg] = h.commit.mock.calls[0] as [string, { path: string; text?: string }[], string, string]
    expect(head).toBe('h1')
    expect(msg).toContain('шапка')
    expect(changes.map((c) => c.path)).toEqual(['banners/bot.webp', 'banners/bot.jpg', 'projects/bot.json'])
    expect(JSON.parse(changes[2]!.text!).banner).toBe('banners/bot.webp')
    expect(h.put).toHaveBeenCalledWith(1, expect.objectContaining({ sha: 'newsha', type: 'image/webp' }))
    const idx = h.saveIndex.mock.calls[0]![1] as Record<string, string>
    expect(idx).toEqual({ 'banners/bot.webp': 'newsha', 'covers/bot.webp': 'cov' })
  })
  it('убрать: удаляет файл, индекс без шапки', async () => {
    h.commit.mockResolvedValue({ head: 'h2', shas: { 'projects/bot.json': 'psha' } })
    await saveBanner('bot', null)
    const [, changes, , msg] = h.commit.mock.calls[0] as [string, { path: string; base64?: null }[], string, string]
    expect(msg).toContain('убрать шапку')
    expect(changes).toContainEqual({ path: 'banners/bot.jpg', base64: null })
    expect((h.saveIndex.mock.calls[0]![1] as Record<string, string>)['banners/bot.jpg']).toBeUndefined()
  })
})
