import { afterEach, describe, expect, it, vi } from 'vitest'
import { BANNER_HEIGHT, BANNER_MAX_BYTES, BANNER_WIDTH, bannerFrameOf, CoverImageError, renderBanner } from './coverFrame'
import { ownBannerPath, ownCoverPath } from './coverImage'

const WEBP = (n: number) => {
  const b = new Uint8Array(n)
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  return b
}
const JPEG = (n: number) => {
  const b = new Uint8Array(n)
  b.set([0xff, 0xd8, 0xff, 0xe0])
  return b
}
const PNG = (n: number) => {
  const b = new Uint8Array(n)
  b.set([0x89, 0x50, 0x4e, 0x47])
  return b
}
interface Call {
  w: number
  h: number
  type: string
  q: number
}
function fakeCanvas(sizeOf: (c: Call) => number, supportsWebp = true) {
  const calls: Call[] = []
  const draws: number[][] = []
  class FakeOffscreen {
    width: number
    height: number
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
    }
    getContext() {
      return { drawImage: (_b: unknown, ...a: number[]) => draws.push(a) }
    }
    async convertToBlob({ type, quality }: { type: string; quality: number }) {
      const c = { w: this.width, h: this.height, type, q: quality }
      calls.push(c)
      const n = sizeOf(c)
      if (type === 'image/webp' && supportsWebp) return new Blob([WEBP(n)], { type })
      if (type === 'image/jpeg') return new Blob([JPEG(n)], { type })
      return new Blob([PNG(n)], { type: 'image/png' })
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
  return { calls, draws }
}
function fakeBitmap(width: number, height: number) {
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })))
  return { close }
}
const file = (type = 'image/jpeg') => new File([new Uint8Array(1000)], 'a', { type })
const mid = { x: 0.5, y: 0.5, zoom: 1 }

afterEach(() => vi.unstubAllGlobals())

describe('ownBannerPath', () => {
  it('принимает только banners/<свой slug>.webp|jpg', () => {
    expect(ownBannerPath('a', 'banners/a.webp')).toBe('banners/a.webp')
    expect(ownBannerPath('a', 'banners/a.jpg')).toBe('banners/a.jpg')
    expect(ownBannerPath('a', 'banners/b.webp')).toBeNull()
    expect(ownBannerPath('foo', 'banners/foo-banner.webp')).toBeNull()
    expect(ownBannerPath('a', 'covers/a.webp')).toBeNull()
    expect(ownBannerPath('a', 'banners/../a.webp')).toBeNull()
    expect(ownBannerPath('a', 'https://x/a.webp')).toBeNull()
    expect(ownBannerPath('a', 'banners/a.svg')).toBeNull()
    expect(ownBannerPath('a', null)).toBeNull()
    expect(ownBannerPath('a', 42)).toBeNull()
  })
  it('обложка и шапка не подменяют друг друга', () => {
    expect(ownCoverPath('a', 'banners/a.webp')).toBeNull()
  })
})

describe('bannerFrameOf', () => {
  it('исходник выше 5:2 — вся ширина, двигается по вертикали', () => {
    expect(bannerFrameOf(1500, 1500, { x: 0.5, y: 0, zoom: 1 })).toEqual({ sx: 0, sy: 0, sw: 1500, sh: 600 })
    expect(bannerFrameOf(1500, 1500, { x: 0.5, y: 1, zoom: 1 }).sy).toBe(900)
    expect(bannerFrameOf(1500, 1500, { x: 1, y: 0.5, zoom: 1 }).sx).toBe(0) // по горизонтали зазора нет
  })
  it('исходник шире 5:2 — вся высота, двигается по горизонтали', () => {
    const f = bannerFrameOf(4000, 600, { x: 1, y: 1, zoom: 1 })
    expect(f.sh).toBe(600)
    expect(f.sw).toBe(1500)
    expect(f.sx).toBe(2500)
    expect(f.sy).toBe(0)
  })
  it('приближение уменьшает кадр, и он двигается по обеим осям', () => {
    const a = bannerFrameOf(2000, 2000, { x: 0, y: 0, zoom: 2 })
    expect(a).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 400 })
    const b = bannerFrameOf(2000, 2000, { x: 1, y: 1, zoom: 2 })
    expect(b).toEqual({ sx: 1000, sy: 1600, sw: 1000, sh: 400 })
  })
  it('кадр 5:2 при любом приближении и не выходит за картинку', () => {
    for (const zoom of [1, 1.5, 3, 4]) {
      for (const [w, h] of [[3000, 1000], [800, 2000], [1500, 600]] as const) {
        for (const p of [0, 0.3, 1]) {
          const f = bannerFrameOf(w, h, { x: p, y: p, zoom })
          expect(f.sw / f.sh).toBeCloseTo(2.5)
          expect(f.sx).toBeGreaterThanOrEqual(-1e-9)
          expect(f.sy).toBeGreaterThanOrEqual(-1e-9)
          expect(f.sx + f.sw).toBeLessThanOrEqual(w + 1e-9)
          expect(f.sy + f.sh).toBeLessThanOrEqual(h + 1e-9)
        }
      }
    }
  })
  it('мусор в положении (NaN, вне границ) не выводит кадр за картинку', () => {
    const f = bannerFrameOf(2000, 2000, { x: NaN, y: 9, zoom: 99 })
    expect(f.sw).toBe(500)
    expect(f.sy + f.sh).toBeLessThanOrEqual(2000)
    expect(bannerFrameOf(2000, 2000, { x: -5, y: -5, zoom: 0 })).toEqual({ sx: 0, sy: 0, sw: 2000, sh: 800 })
  })
})

describe('renderBanner', () => {
  it('всегда 1500×600, WebP, кадр из положения, поворот по EXIF запрошен', async () => {
    fakeBitmap(3000, 3000)
    const { calls, draws } = fakeCanvas(() => 100_000)
    const r = await renderBanner(file(), { x: 0.5, y: 0, zoom: 1 })
    expect(r.ext).toBe('webp')
    expect(calls).toEqual([{ w: BANNER_WIDTH, h: BANNER_HEIGHT, type: 'image/webp', q: 0.85 }])
    expect(draws[0]).toEqual([0, 0, 3000, 1200, 0, 0, 1500, 600])
  })
  it('маленький исходник растягивается до 1500×600', async () => {
    fakeBitmap(500, 200)
    const { calls } = fakeCanvas(() => 1000)
    await renderBanner(file())
    expect(calls[0]).toMatchObject({ w: 1500, h: 600 })
  })
  it('качество снижается, пока не влезет в 500 КБ; ровно 500 КБ принимается', async () => {
    fakeBitmap(2000, 2000)
    const { calls } = fakeCanvas((c) => (c.q > 0.7 ? BANNER_MAX_BYTES + 1 : BANNER_MAX_BYTES))
    const r = await renderBanner(file(), mid)
    expect(r.bytes.length).toBe(BANNER_MAX_BYTES)
    expect(calls.map((c) => c.q)).toEqual([0.85, 0.75, 0.65])
  })
  it('не влезло ни при каком качестве — понятная ошибка, bitmap освобождён', async () => {
    const { close } = fakeBitmap(2000, 2000)
    fakeCanvas(() => BANNER_MAX_BYTES + 1)
    await expect(renderBanner(file(), mid)).rejects.toThrow(/500 КБ/)
    expect(close).toHaveBeenCalled()
  })
  it('браузер без WebP — JPEG, расширение jpg', async () => {
    fakeBitmap(2000, 2000)
    const { calls } = fakeCanvas(() => 5000, false)
    const r = await renderBanner(file(), mid)
    expect(r.ext).toBe('jpg')
    expect(calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg'])
  })
  it('не картинка отклоняется до декодирования; битая картинка — ошибка', async () => {
    const create = vi.fn()
    vi.stubGlobal('createImageBitmap', create)
    await expect(renderBanner(file('image/svg+xml'), mid)).rejects.toThrow(CoverImageError)
    expect(create).not.toHaveBeenCalled()
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('bad'))))
    await expect(renderBanner(file(), mid)).rejects.toThrow(/Не удалось открыть/)
  })
})
