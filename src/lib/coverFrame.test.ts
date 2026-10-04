import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSourceFile, COVER_MAX_BYTES, CoverImageError, frameOf, renderCover } from './coverFrame'

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

/** Подмена canvas: размер результата считает sizeOf(вызов); drawImage запоминает аргументы. */
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
  const create = vi.fn(async () => ({ width, height, close }))
  vi.stubGlobal('createImageBitmap', create)
  return { create, close }
}

const file = (type = 'image/jpeg', size = 1000) => new File([new Uint8Array(size)], 'a', { type })

afterEach(() => vi.unstubAllGlobals())

describe('frameOf', () => {
  it('по ширине, смещение по вертикали', () => {
    expect(frameOf(1600, 1600, 0)).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 600 })
    expect(frameOf(1600, 1600, 1).sy).toBe(1000)
    expect(frameOf(1600, 1600, 0.5).sy).toBe(500)
  })
  it('смещение вне 0..1 и NaN не выводят кадр за картинку', () => {
    expect(frameOf(1600, 1600, 5).sy).toBe(1000)
    expect(frameOf(1600, 1600, -1).sy).toBe(0)
    expect(frameOf(1600, 1600, NaN).sy).toBe(500)
  })
  it('исходник уже кадра — вся картинка', () => {
    expect(frameOf(1600, 600, 0.9)).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 600 })
  })
  it('исходник шире кадра — вся высота, центр по горизонтали', () => {
    const f = frameOf(3000, 600, 0.5)
    expect(f.sh).toBe(600)
    expect(f.sw).toBeCloseTo(1600)
    expect(f.sx).toBeCloseTo(700)
  })
})

describe('checkSourceFile', () => {
  it('отклоняет не-картинки, SVG и файлы больше 20 МБ', () => {
    expect(() => checkSourceFile({ type: 'text/html', size: 10 })).toThrow(CoverImageError)
    expect(() => checkSourceFile({ type: 'image/svg+xml', size: 10 })).toThrow(CoverImageError)
    expect(() => checkSourceFile({ type: '', size: 10 })).toThrow(CoverImageError)
    expect(() => checkSourceFile({ type: 'image/png', size: 21 * 1024 * 1024 })).toThrow(/20 МБ/)
    expect(() => checkSourceFile({ type: 'image/png', size: 1000 })).not.toThrow()
  })
  it('до декодирования: createImageBitmap не вызывается', async () => {
    const { create } = fakeBitmap(100, 100)
    await expect(renderCover(file('text/plain'))).rejects.toThrow(CoverImageError)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('renderCover', () => {
  it('WebP, ширина min(1600, исходная), высота 6/16, поворот по EXIF запрошен', async () => {
    const { create } = fakeBitmap(4000, 3000)
    const { calls, draws } = fakeCanvas(() => 100_000)
    const r = await renderCover(file(), 0)
    expect(r.ext).toBe('webp')
    expect(create).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ w: 1600, h: 600, type: 'image/webp', q: 0.85 })
    expect(draws[0]).toEqual([0, 0, 4000, 1500, 0, 0, 1600, 600]) // верх при offset 0
  })
  it('маленький исходник не растягивается', async () => {
    fakeBitmap(800, 800)
    const { calls } = fakeCanvas(() => 1000)
    await renderCover(file())
    expect(calls[0]).toMatchObject({ w: 800, h: 300 })
  })
  it('качество снижается, пока не влезет в 300 КБ', async () => {
    fakeBitmap(2000, 2000)
    const { calls } = fakeCanvas((c) => (c.q > 0.7 ? COVER_MAX_BYTES + 1 : COVER_MAX_BYTES))
    const r = await renderCover(file())
    expect(r.bytes.length).toBe(COVER_MAX_BYTES)
    expect(calls.map((c) => c.q)).toEqual([0.85, 0.75, 0.65])
  })
  it('не влезло ни при каком качестве — ширина уменьшается', async () => {
    fakeBitmap(2000, 2000)
    const { calls } = fakeCanvas((c) => (c.w > 1400 ? COVER_MAX_BYTES + 1 : 1000))
    await renderCover(file())
    expect(calls.at(-1)!.w).toBe(1280)
  })
  it('вообще не сжимается — понятная ошибка', async () => {
    fakeBitmap(2000, 2000)
    fakeCanvas(() => COVER_MAX_BYTES + 1)
    await expect(renderCover(file())).rejects.toThrow(/300 КБ/)
  })
  it('браузер отдаёт PNG вместо WebP — откат на JPEG, расширение jpg', async () => {
    fakeBitmap(2000, 2000)
    const { calls } = fakeCanvas(() => 5000, false)
    const r = await renderCover(file())
    expect(r.ext).toBe('jpg')
    expect(calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg'])
    expect(r.bytes[0]).toBe(0xff)
  })
  it('повреждённая картинка — ошибка', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('bad'))))
    await expect(renderCover(file())).rejects.toThrow(/Не удалось открыть/)
  })
  it('bitmap освобождается', async () => {
    const { close } = fakeBitmap(1000, 1000)
    fakeCanvas(() => 100)
    await renderCover(file())
    expect(close).toHaveBeenCalled()
  })
})

describe('renderCover: граничные случаи', () => {
  it('ровно 20 МБ проходит, на байт больше нет; ровно 300 КБ принимается', async () => {
    expect(() => checkSourceFile({ type: 'image/png', size: 20 * 1024 * 1024 })).not.toThrow()
    expect(() => checkSourceFile({ type: 'image/png', size: 20 * 1024 * 1024 + 1 })).toThrow(CoverImageError)
    fakeBitmap(2000, 2000)
    fakeCanvas(() => COVER_MAX_BYTES)
    expect((await renderCover(file())).bytes.length).toBe(COVER_MAX_BYTES)
  })
  it('крошечный исходник: высота не ноль', async () => {
    fakeBitmap(2, 1)
    const { calls } = fakeCanvas(() => 100)
    await renderCover(file())
    expect(calls[0].h).toBeGreaterThanOrEqual(1)
    expect(calls[0].w).toBe(2)
  })
  it('широкая панорама: кадр по высоте, ширина ограничена 1600', async () => {
    fakeBitmap(10000, 600)
    const { calls, draws } = fakeCanvas(() => 100)
    await renderCover(file())
    expect(calls[0].w).toBe(1600)
    expect(draws[0][3]).toBe(600)
  })
  it('сжатие не опускается ниже 480 px', async () => {
    fakeBitmap(4000, 4000)
    const { calls } = fakeCanvas(() => COVER_MAX_BYTES + 1)
    await expect(renderCover(file())).rejects.toThrow(/300 КБ/)
    expect(Math.min(...calls.map((c) => c.w))).toBeGreaterThanOrEqual(480)
  })
  it('canvas отдаёт PNG даже для JPEG: понятная ошибка', async () => {
    fakeBitmap(2000, 2000)
    fakeCanvas(() => 50, false)
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage: () => undefined }
        }
        async convertToBlob() {
          return new Blob([PNG(50)], { type: 'image/png' })
        }
      },
    )
    await expect(renderCover(file())).rejects.toThrow(/Браузер не смог/)
  })
  it('нет 2d-контекста: ошибка, bitmap закрыт', async () => {
    const { close } = fakeBitmap(2000, 2000)
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return null } })
    await expect(renderCover(file())).rejects.toBeInstanceOf(CoverImageError)
    expect(close).toHaveBeenCalled()
  })
  it('ошибка кодирования закрывает bitmap', async () => {
    const { close } = fakeBitmap(2000, 2000)
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {} } } async convertToBlob() { throw new Error('boom') } })
    await expect(renderCover(file())).rejects.toThrow('boom')
    expect(close).toHaveBeenCalled()
  })
})
