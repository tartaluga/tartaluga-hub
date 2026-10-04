import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ readBlobBytes: vi.fn() }))
import { readBlobBytes } from './api'
import { loadCover, ownCoverPath, resetCoverState, sniffCover, watchCover } from './coverImage'
import { getCover, putCover, putCoverIndex, pruneCovers, wipeDevice } from './localdb'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const read = vi.mocked(readBlobBytes)

beforeEach(async () => {
  await wipeDevice()
  resetCoverState()
  read.mockReset()
})

describe('сигнатура и путь', () => {
  it('WebP и JPEG узнаются, остальное нет', () => {
    expect(sniffCover(webp)).toBe('image/webp')
    expect(sniffCover(jpeg)).toBe('image/jpeg')
    expect(sniffCover(svg)).toBeNull()
    expect(sniffCover(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull()
  })
  it('cover принимается только для своего slug', () => {
    expect(ownCoverPath('a', 'covers/a.webp')).toBe('covers/a.webp')
    expect(ownCoverPath('a', 'covers/a.jpg')).toBe('covers/a.jpg')
    expect(ownCoverPath('a', 'covers/b.webp')).toBeNull()
    expect(ownCoverPath('a', 'covers/../a.webp')).toBeNull()
    expect(ownCoverPath('a', 'https://x/a.webp')).toBeNull()
    expect(ownCoverPath('a', 'covers/a.svg')).toBeNull()
    expect(ownCoverPath('a', null)).toBeNull()
    expect(ownCoverPath('a', 5)).toBeNull()
  })
})

describe('loadCover', () => {
  it('промах: запрос, проверка, запись в кэш; второй раз без сети', async () => {
    read.mockResolvedValue(webp)
    const b = await loadCover('main', 'a', 'covers/a.webp', { 'covers/a.webp': SHA })
    expect(b?.type).toBe('image/webp')
    expect((await getCover(SHA))?.type).toBe('image/webp')
    read.mockRejectedValue(new Error('offline'))
    const again = await loadCover('main', 'a', 'covers/a.webp', { 'covers/a.webp': SHA })
    expect(again?.type).toBe('image/webp')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('попадание в кэш без сети, sha берётся из сохранённого индекса', async () => {
    await putCover({ sha: SHA, type: 'image/jpeg', bytes: new Blob([jpeg]) })
    await putCoverIndex('main', { 'covers/a.jpg': SHA })
    read.mockRejectedValue(new Error('offline'))
    const b = await loadCover('main', 'a', 'covers/a.jpg')
    expect(b?.type).toBe('image/jpeg')
    expect(read).not.toHaveBeenCalled()
  })
  it('плохая сигнатура: null, в кэш не попадает, повторно не запрашивается', async () => {
    read.mockResolvedValue(svg)
    const idx = { 'covers/a.webp': SHA }
    expect(await loadCover('main', 'a', 'covers/a.webp', idx)).toBeNull()
    expect(await getCover(SHA)).toBeUndefined()
    expect(await loadCover('main', 'a', 'covers/a.webp', idx)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('чужой путь в cover: null, сеть не трогаем', async () => {
    expect(await loadCover('main', 'a', 'covers/b.webp', { 'covers/b.webp': SHA })).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('файла нет в списке ветки: null', async () => {
    expect(await loadCover('main', 'a', 'covers/a.webp', {})).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('ошибка сети: null, без повтора сразу', async () => {
    read.mockRejectedValue(new Error('offline'))
    const idx = { 'covers/a.webp': SHA }
    expect(await loadCover('main', 'a', 'covers/a.webp', idx)).toBeNull()
    expect(await loadCover('main', 'a', 'covers/a.webp', idx)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('одинаковые запросы с разных экранов объединяются', async () => {
    read.mockResolvedValue(webp)
    const idx = { 'covers/a.webp': SHA }
    await Promise.all([loadCover('main', 'a', 'covers/a.webp', idx), loadCover('main', 'a', 'covers/a.webp', idx)])
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('чистка кэша обложек', () => {
  it('остаются только обложки, sha которых есть в индексе какой-то ветки', async () => {
    await putCover({ sha: SHA, type: 'image/webp', bytes: new Blob([webp]) })
    await putCover({ sha: SHA2, type: 'image/webp', bytes: new Blob([webp]) })
    await putCoverIndex('main', { 'covers/a.webp': SHA })
    await pruneCovers()
    expect(await getCover(SHA)).toBeDefined()
    expect(await getCover(SHA2)).toBeUndefined()
  })
})

describe('watchCover', () => {
  it('отдаёт object URL и освобождает его при отмене', async () => {
    const create = vi.fn(() => 'blob:one')
    const revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    read.mockResolvedValue(jpeg)
    const seen: (string | null)[] = []
    const stop = watchCover('main', 'a', 'covers/a.jpg', { 'covers/a.jpg': SHA }, (u) => seen.push(u))
    await vi.waitFor(() => expect(seen).toEqual([null, 'blob:one']))
    stop()
    expect(revoke).toHaveBeenCalledWith('blob:one')
  })
  it('отмена до ответа: URL не создаётся', async () => {
    const create = vi.fn(() => 'blob:two')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
    read.mockResolvedValue(jpeg)
    const seen: (string | null)[] = []
    watchCover('main', 'a', 'covers/a.jpg', { 'covers/a.jpg': SHA }, (u) => seen.push(u))()
    await new Promise((r) => setTimeout(r, 20))
    expect(create).not.toHaveBeenCalled()
    expect(seen).toEqual([null])
  })
})
