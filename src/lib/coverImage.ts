// Загрузка обложки проекта: проверка поля cover, sha файла, кэш на устройстве, запрос blob-а, проверка байт.
// Поле cover — недоверенный ввод из репо: берём только covers/<этот slug>.webp|.jpg, и только если файл есть в списке ветки.
import { readBlobBytes } from './api'
import { getCover, getCoverIndex, putCover, type CoverIndex } from './localdb'

export type CoverType = 'image/webp' | 'image/jpeg'

/** Путь обложки проекта, если поле cover допустимо для этого slug; иначе null. */
export function ownCoverPath(slug: string, cover: unknown): string | null {
  return typeof cover === 'string' && (cover === `covers/${slug}.webp` || cover === `covers/${slug}.jpg`) ? cover : null
}

/** Тип картинки по первым байтам: WebP (RIFF....WEBP) или JPEG (FF D8 FF). Остальное, в том числе SVG и HTML, — null. */
export function sniffCover(b: Uint8Array): CoverType | null {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  return null
}

const SHA = /^[0-9a-f]{40}$/
/** Сбой сети не повторяем чаще, чем раз в эту паузу (нет бесконечных повторов при перерисовках). */
export const RETRY_AFTER_MS = 60_000

const inFlight = new Map<string, Promise<Blob | null>>()
const badSha = new Set<string>() // содержимое под sha неизменно: плохая сигнатура не исправится
const failedAt = new Map<string, number>()

/** Только для тестов. */
export function resetCoverState(): void {
  inFlight.clear()
  badSha.clear()
  failedAt.clear()
}

async function fetchCover(sha: string): Promise<Blob | null> {
  try {
    const cached = await getCover(sha)
    if (cached && sniffCover(new Uint8Array(await cached.bytes.slice(0, 12).arrayBuffer()))) return new Blob([cached.bytes], { type: cached.type })
  } catch {
    /* кэш недоступен — идём в сеть */
  }
  if (badSha.has(sha)) return null
  const last = failedAt.get(sha)
  if (last !== undefined && Date.now() - last < RETRY_AFTER_MS) return null
  try {
    const bytes = await readBlobBytes(sha)
    const type = sniffCover(bytes)
    if (!type) {
      badSha.add(sha)
      return null
    }
    const blob = new Blob([bytes as BlobPart], { type })
    await putCover({ sha, type, bytes: blob }).catch(() => undefined)
    failedAt.delete(sha)
    return blob
  } catch {
    failedAt.set(sha, Date.now())
    return null
  }
}

/** Картинка обложки или null (нет в списке, нет сети, плохие байты). Одинаковые запросы объединяются. */
export async function loadCover(branch: string, slug: string, cover: unknown, liveIndex?: CoverIndex): Promise<Blob | null> {
  const path = ownCoverPath(slug, cover)
  if (!path) return null
  let sha = liveIndex?.[path]
  if (!sha) sha = (await getCoverIndex(branch).catch(() => ({}) as CoverIndex))[path]
  if (!sha || !SHA.test(sha)) return null
  let p = inFlight.get(sha)
  if (!p) {
    p = fetchCover(sha).finally(() => inFlight.delete(sha))
    inFlight.set(sha, p)
  }
  return p
}

/**
 * Показ обложки: грузит картинку и отдаёт её object URL через onUrl (null — заглушка). Возвращает отмену:
 * освобождает созданный URL (revokeObjectURL) и глушит запоздавший ответ.
 */
export function watchCover(branch: string, slug: string, cover: unknown, index: CoverIndex | undefined, onUrl: (url: string | null) => void): () => void {
  let cancelled = false
  let made: string | null = null
  onUrl(null)
  void loadCover(branch, slug, cover, index).then((blob) => {
    if (cancelled || !blob) return
    made = URL.createObjectURL(blob)
    onUrl(made)
  })
  return () => {
    cancelled = true
    if (made) URL.revokeObjectURL(made)
  }
}
