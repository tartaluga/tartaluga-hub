import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  queued: { value: false },
  commit: vi.fn(),
  applyWrite: vi.fn(async (..._a: unknown[]) => undefined),
  refresh: vi.fn(async () => undefined),
  put: vi.fn(async (..._a: unknown[]) => undefined),
  saveIndex: vi.fn(),
  epoch: { value: 1 },
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
vi.mock('../lib/localdb', () => ({ deviceEpoch: () => h.epoch.value, putCoverIfCurrent: h.put, saveCoverIndex: h.saveIndex }))

import { ApiError } from '../lib/api'
import { saveCover } from './coverEdit'

const webp = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), ext: 'webp' as const }
const projText = JSON.stringify({ schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', createdAt: '2026-09-01T10:00:00+03:00', updatedAt: '2026-09-01T10:00:00+03:00' })

beforeEach(() => {
  vi.clearAllMocks()
  h.queued.value = false
  h.epoch.value = 1
  Object.assign(h.state, {
    branch: 'main',
    refresh: h.refresh,
    tree: { head: 'h1', paths: ['projects/bot.json', 'covers/bot.jpg'], covers: { 'covers/bot.jpg': 'old' } },
    files: [{ path: 'projects/bot.json', sha: 's', text: projText }],
  })
  h.commit.mockResolvedValue({ head: 'h2', shas: { 'covers/bot.webp': 'newsha', 'projects/bot.json': 'psha' } })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

describe('saveCover', () => {
  it('офлайн: сеть не трогаем', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await expect(saveCover('bot', webp)).rejects.toMatchObject({ status: 0 })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('есть правка в очереди: 423, без коммита', async () => {
    h.queued.value = true
    await expect(saveCover('bot', webp)).rejects.toMatchObject({ status: 423 })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('байты не совпадают с расширением или пусты: отказ до коммита', async () => {
    await expect(saveCover('bot', { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), ext: 'webp' })).rejects.toMatchObject({ status: 422 })
    await expect(saveCover('bot', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), ext: 'webp' })).rejects.toMatchObject({ status: 422 })
    await expect(saveCover('bot', { bytes: webp.bytes, ext: 'jpg' })).rejects.toMatchObject({ status: 422 })
    await expect(saveCover('bot', { bytes: new Uint8Array(), ext: 'jpg' })).rejects.toMatchObject({ status: 422 })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('проекта нет в ветке: 404', async () => {
    h.state.files = []
    await expect(saveCover('bot', webp)).rejects.toMatchObject({ status: 404 })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('нет дерева даже после refresh: сетевая ошибка', async () => {
    h.state.tree = null
    await expect(saveCover('bot', webp)).rejects.toMatchObject({ status: 0 })
    expect(h.refresh).toHaveBeenCalled()
  })
  it('успех: один коммит с головой дерева, индекс обложек обновлён, старый файл убран, кэш пополнен', async () => {
    await saveCover('bot', webp)
    expect(h.commit).toHaveBeenCalledTimes(1)
    const [branch, changes, head, msg] = h.commit.mock.calls[0] as [string, { path: string }[], string, string]
    expect(branch).toBe('main')
    expect(head).toBe('h1')
    expect(msg).toContain('bot')
    expect(changes.map((c) => c.path)).toEqual(['covers/bot.webp', 'covers/bot.jpg', 'projects/bot.json'])
    expect(h.applyWrite).toHaveBeenCalledWith('main', [expect.objectContaining({ path: 'projects/bot.json', sha: 'psha' })], ['covers/bot.jpg'], 'h2')
    expect(h.put).toHaveBeenCalledWith(1, expect.objectContaining({ sha: 'newsha', type: 'image/webp' }))
    expect(h.saveIndex).toHaveBeenCalledWith('main', { 'covers/bot.webp': 'newsha' })
  })
  it('убрать обложку: кэш не пополняется, из индекса уходит старая', async () => {
    h.commit.mockResolvedValue({ head: 'h2', shas: { 'projects/bot.json': 'psha' } })
    await saveCover('bot', null)
    expect(h.put).not.toHaveBeenCalled()
    expect(h.saveIndex).toHaveBeenCalledWith('main', {})
  })
  it('409: дерево перечитано, ошибка уходит наверх, локальная запись не делается', async () => {
    h.commit.mockRejectedValue(new ApiError(409, 'conflict', 'x'))
    await expect(saveCover('bot', webp)).rejects.toMatchObject({ status: 409 })
    expect(h.refresh).toHaveBeenCalled()
    expect(h.state.tree).toBeNull()
    expect(h.applyWrite).not.toHaveBeenCalled()
  })
  it('другая ошибка коммита: перечитывания нет', async () => {
    h.commit.mockRejectedValue(new ApiError(503, 'upstream_unavailable', 'x'))
    await expect(saveCover('bot', webp)).rejects.toMatchObject({ status: 503 })
    expect(h.refresh).not.toHaveBeenCalled()
  })
  it('«Выйти» во время коммита: ни байты, ни индекс в базу не пишутся', async () => {
    h.commit.mockImplementation(async () => {
      h.epoch.value = 2
      return { head: 'h2', shas: { 'covers/bot.webp': 'newsha', 'projects/bot.json': 'psha' } }
    })
    await saveCover('bot', webp)
    expect(h.put).toHaveBeenCalledWith(1, expect.anything())
    expect(h.saveIndex).not.toHaveBeenCalled()
  })
  it('сбой кэша обложки не ломает сохранение', async () => {
    h.put.mockRejectedValueOnce(new Error('quota'))
    await expect(saveCover('bot', webp)).resolves.toBeUndefined()
    expect(h.saveIndex).toHaveBeenCalled()
  })
})
