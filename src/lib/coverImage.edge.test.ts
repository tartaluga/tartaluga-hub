import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ readBlobBytes: vi.fn() }))
import { readBlobBytes } from './api'
import { RETRY_AFTER_MS, loadCover, ownCoverPath, resetCoverState, sniffCover } from './coverImage'
import { dropBranchCache, getCover, getCoverIndex, putCover, putCoverIndex, pruneCovers, saveCoverIndex, wipeDevice } from './localdb'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const read = vi.mocked(readBlobBytes)
const IDX = { 'covers/a.webp': SHA }

beforeEach(async () => {
  await wipeDevice()
  resetCoverState()
  read.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('sniffCover: граничные байты', () => {
  it('пусто, обрывки и чужие форматы', () => {
    expect(sniffCover(new Uint8Array())).toBeNull()
    expect(sniffCover(new Uint8Array([0xff, 0xd8]))).toBeNull()
    expect(sniffCover(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull()
    expect(sniffCover(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(sniffCover(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
    expect(sniffCover(new TextEncoder().encode('GIF89a......'))).toBeNull()
  })
  it('RIFF не WebP (AVI/WAVE) и WebP короче 12 байт отвергаются', () => {
    const avi = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])
    expect(sniffCover(avi)).toBeNull()
    expect(sniffCover(webp.slice(0, 11))).toBeNull()
    expect(sniffCover(webp.slice(0, 12))).toBe('image/webp')
  })
  it('сигнатура регистрозависима и должна стоять в начале', () => {
    expect(sniffCover(new TextEncoder().encode('riff....webp'))).toBeNull()
    expect(sniffCover(new Uint8Array([0, ...webp]))).toBeNull()
    expect(sniffCover(new Uint8Array([0, ...jpeg]))).toBeNull()
  })
})

describe('ownCoverPath: недоверенное поле', () => {
  it('всё лишнее отвергается', () => {
    const bad: unknown[] = ['covers/a.WEBP', 'covers/A.webp', ' covers/a.webp', 'covers/a.webp ', 'covers/a.webp/', '/covers/a.webp', 'covers//a.webp', 'covers/a.png', 'covers/a.jpeg', 'covers/a.webp?x=1', 'covers/a.webp\n', 'covers/a.webp.svg', undefined, {}, [], ['covers/a.webp'], true]
    for (const b of bad) expect(ownCoverPath('a', b), String(b)).toBeNull()
  })
  it('slug с символами регулярки не работает как шаблон', () => {
    expect(ownCoverPath('a.b', 'covers/aXb.webp')).toBeNull()
    expect(ownCoverPath('a.b', 'covers/a.b.webp')).toBe('covers/a.b.webp')
  })
})

describe('loadCover: sha и индекс', () => {
  it('некорректный sha в индексе: null, сеть не трогаем', async () => {
    for (const sha of ['', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '../x', 'g'.repeat(40), SHA + '\n']) {
      expect(await loadCover('main', 'a', 'covers/a.webp', { 'covers/a.webp': sha }), sha).toBeNull()
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('свежий индекс приоритетнее сохранённого', async () => {
    await putCoverIndex('main', { 'covers/a.webp': SHA2 })
    read.mockResolvedValue(webp)
    await loadCover('main', 'a', 'covers/a.webp', IDX)
    expect(read).toHaveBeenCalledWith(SHA)
  })
  it('без свежего индекса берётся сохранённый индекс именно этой ветки', async () => {
    await putCoverIndex('other', IDX)
    expect(await loadCover('main', 'a', 'covers/a.webp')).toBeNull()
    expect(read).not.toHaveBeenCalled()
    read.mockResolvedValue(webp)
    expect(await loadCover('other', 'a', 'covers/a.webp')).not.toBeNull()
  })
  it('пустой cover и несовпадающее расширение: null', async () => {
    expect(await loadCover('main', 'a', '', IDX)).toBeNull()
    expect(await loadCover('main', 'a', undefined, IDX)).toBeNull()
    expect(await loadCover('main', 'a', 'covers/a.jpg', IDX)).toBeNull()
  })
})

describe('loadCover: кэш и сеть', () => {
  it('испорченные байты в кэше не показываются: идём в сеть и перезаписываем', async () => {
    await putCover({ sha: SHA, type: 'image/webp', bytes: new Blob(['<svg onload=alert(1)>']) })
    read.mockResolvedValue(webp)
    const b = await loadCover('main', 'a', 'covers/a.webp', IDX)
    expect(b?.type).toBe('image/webp')
    expect(read).toHaveBeenCalledTimes(1)
    expect(await (await getCover(SHA))!.bytes.slice(0, 4).text()).toBe('RIFF')
  })
  it('испорченный кэш без сети: null, а не мусор', async () => {
    await putCover({ sha: SHA, type: 'image/webp', bytes: new Blob([new Uint8Array(3)]) })
    read.mockRejectedValue(new Error('offline'))
    expect(await loadCover('main', 'a', 'covers/a.webp', IDX)).toBeNull()
  })
  it('пустой ответ сервера: null и не кэшируется', async () => {
    read.mockResolvedValue(new Uint8Array())
    expect(await loadCover('main', 'a', 'covers/a.webp', IDX)).toBeNull()
    expect(await getCover(SHA)).toBeUndefined()
  })
  it('тип берётся из байт; JPEG под путём .webp допустим', async () => {
    read.mockResolvedValue(jpeg)
    const b = await loadCover('main', 'a', 'covers/a.webp', IDX)
    expect(b?.type).toBe('image/jpeg')
    expect((await getCover(SHA))?.type).toBe('image/jpeg')
  })
  it('сбой сети: через RETRY_AFTER_MS повтор, успех отдаёт картинку', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    read.mockRejectedValue(new Error('offline'))
    expect(await loadCover('main', 'a', 'covers/a.webp', IDX)).toBeNull()
    vi.advanceTimersByTime(RETRY_AFTER_MS - 1)
    expect(await loadCover('main', 'a', 'covers/a.webp', IDX)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    read.mockResolvedValue(webp)
    expect(await loadCover('main', 'a', 'covers/a.webp', IDX)).not.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('сбой одной обложки не блокирует другую', async () => {
    read.mockImplementation(async (s) => {
      if (s === SHA) throw new Error('x')
      return webp
    })
    expect(await loadCover('main', 'a', 'covers/a.webp', IDX)).toBeNull()
    expect(await loadCover('main', 'b', 'covers/b.webp', { 'covers/b.webp': SHA2 })).not.toBeNull()
  })
})

describe('индекс и чистка', () => {
  it('getCoverIndex отбрасывает не-строки и не-объекты', async () => {
    await putCoverIndex('m', { ok: SHA, n: 5, o: {}, z: null } as never)
    expect(await getCoverIndex('m')).toEqual({ ok: SHA })
    await putCoverIndex('arr', [SHA] as never)
    expect(await getCoverIndex('arr')).toEqual({})
    await putCoverIndex('nul', null as never)
    expect(await getCoverIndex('nul')).toEqual({})
    expect(await getCoverIndex('none')).toEqual({})
  })
  it('pruneCovers на пустой базе не падает; sha из разных веток живут', async () => {
    await pruneCovers()
    await putCover({ sha: SHA, type: 'image/webp', bytes: new Blob([webp]) })
    await putCover({ sha: SHA2, type: 'image/webp', bytes: new Blob([webp]) })
    await putCoverIndex('main', { 'covers/a.webp': SHA })
    await putCoverIndex('w/x', { 'covers/a.webp': SHA2 })
    await pruneCovers()
    expect(await getCover(SHA)).toBeDefined()
    expect(await getCover(SHA2)).toBeDefined()
  })
  it('удаление ветки убирает её индекс и обложки, которых больше нигде нет', async () => {
    await putCover({ sha: SHA, type: 'image/webp', bytes: new Blob([webp]) })
    await putCover({ sha: SHA2, type: 'image/webp', bytes: new Blob([webp]) })
    await putCoverIndex('main', { 'covers/a.webp': SHA })
    await putCoverIndex('w/x', { 'covers/a.webp': SHA, 'covers/b.webp': SHA2 })
    await dropBranchCache('w/x')
    expect(await getCoverIndex('w/x')).toEqual({})
    expect(await getCover(SHA)).toBeDefined()
    expect(await getCover(SHA2)).toBeUndefined()
  })
  it('saveCoverIndex пишет индекс и чистит; wipeDevice дожидается записи', async () => {
    await putCover({ sha: SHA2, type: 'image/webp', bytes: new Blob([webp]) })
    saveCoverIndex('main', { 'covers/a.webp': SHA })
    await wipeDevice()
    await new Promise((r) => setTimeout(r, 50))
    expect(await getCoverIndex('main')).toEqual({})
    expect(await getCover(SHA2)).toBeUndefined()
  })
  it('saveCoverIndex убирает устаревшие байты после смены sha', async () => {
    await putCover({ sha: SHA2, type: 'image/webp', bytes: new Blob([webp]) })
    await putCoverIndex('main', { 'covers/a.webp': SHA2 })
    saveCoverIndex('main', { 'covers/a.webp': SHA })
    await vi.waitFor(async () => expect(await getCover(SHA2)).toBeUndefined())
  })
})
