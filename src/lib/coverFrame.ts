// Загрузка своей обложки (G2): из выбранного файла вырезаем кадр 16:6 (ADR-009), поворачиваем по EXIF,
// сжимаем до 300 КБ и кодируем в WebP (JPEG — там, где браузер WebP не умеет, например Safari).
import { sniffCover } from './coverImage'

export const COVER_MAX_BYTES = 300 * 1024
export const SOURCE_MAX_BYTES = 20 * 1024 * 1024
export const COVER_MAX_WIDTH = 1600
const MIN_WIDTH = 480
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.5]

export class CoverImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoverImageError'
  }
}

export interface EncodedCover {
  bytes: Uint8Array
  ext: 'webp' | 'jpg'
}

/** Проверка файла до декодирования: только растровая картинка и не больше 20 МБ. SVG не принимаем (это разметка, не растр). */
export function checkSourceFile(file: { type: string; size: number }): void {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new CoverImageError('Нужна картинка (JPEG, PNG, WebP). Другие файлы не подходят.')
  if (file.size > SOURCE_MAX_BYTES) throw new CoverImageError('Файл больше 20 МБ. Выбери картинку поменьше.')
}

export interface Frame {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Кадр 16:6 в исходной картинке. По ширине — вся ширина, положение по вертикали задаёт offset (0 — верх, 1 — низ).
 * Если исходник шире кадра (по высоте кадр не помещается), берём всю высоту и центр по горизонтали.
 */
export function frameOf(srcW: number, srcH: number, offset: number): Frame {
  const o = Math.min(1, Math.max(0, Number.isFinite(offset) ? offset : 0.5))
  const sh = (srcW * 6) / 16
  if (sh <= srcH) return { sx: 0, sy: (srcH - sh) * o, sw: srcW, sh }
  const sw = (srcH * 16) / 6
  return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

async function encode(width: number, height: number, draw: (ctx: Ctx2D) => void, type: string, quality: number): Promise<Uint8Array | null> {
  let blob: Blob | null
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    draw(ctx)
    blob = await c.convertToBlob({ type, quality })
  } else {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return null
    draw(ctx)
    blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality))
  }
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

/** Готовая обложка из файла: кадр 16:6, до 300 КБ, WebP или JPEG. offset — положение кадра по вертикали, 0..1. */
export async function renderCover(file: File, offset = 0.5): Promise<EncodedCover> {
  checkSourceFile(file)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new CoverImageError('Не удалось открыть картинку. Возможно, файл повреждён.')
  }
  try {
    const f = frameOf(bitmap.width, bitmap.height, offset)
    let width = Math.min(COVER_MAX_WIDTH, Math.floor(f.sw))
    const floor = Math.min(MIN_WIDTH, width)
    let format: 'image/webp' | 'image/jpeg' = 'image/webp'
    while (width >= floor) {
      const w = width
      const height = Math.max(1, Math.round((w * 6) / 16))
      const draw = (ctx: Ctx2D) => ctx.drawImage(bitmap, f.sx, f.sy, f.sw, f.sh, 0, 0, w, height)
      for (const q of QUALITIES) {
        let bytes = await encode(w, height, draw, format, q)
        // Браузер не умеет WebP и отдал PNG (Safari): переходим на JPEG.
        if (format === 'image/webp' && (!bytes || sniffCover(bytes) !== 'image/webp')) {
          format = 'image/jpeg'
          bytes = await encode(w, height, draw, format, q)
        }
        if (!bytes || sniffCover(bytes) !== format) throw new CoverImageError('Браузер не смог сжать картинку.')
        if (bytes.length <= COVER_MAX_BYTES) return { bytes, ext: format === 'image/webp' ? 'webp' : 'jpg' }
      }
      width = Math.floor(width * 0.8)
    }
    throw new CoverImageError('Не удалось сжать картинку до 300 КБ. Выбери другую.')
  } finally {
    bitmap.close?.()
  }
}
