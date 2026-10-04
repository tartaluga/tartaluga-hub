import { describe, expect, it } from 'vitest'
import { buildCoverChanges } from './coverEdit'

const text = JSON.stringify({ schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', cover: 'covers/bot.webp', mystery: { a: 1 }, createdAt: '2026-09-01T10:00:00+03:00', updatedAt: '2026-09-01T10:00:00+03:00' })
const webp = { bytes: new Uint8Array([1, 2, 3]), ext: 'webp' as const }
const now = new Date('2026-10-04T10:00:00Z')

describe('buildCoverChanges: шапка', () => {
  it('ставит banners/<slug>.<ext> и поле banner, обложку не трогает, незнакомые поля сохраняет', () => {
    const ch = buildCoverChanges('bot', text, webp, ['projects/bot.json', 'covers/bot.webp'], now, 'banner')
    expect(ch.map((c) => c.path)).toEqual(['banners/bot.webp', 'projects/bot.json'])
    const proj = JSON.parse((ch[1] as { text: string }).text)
    expect(proj.banner).toBe('banners/bot.webp')
    expect(proj.cover).toBe('covers/bot.webp')
    expect(proj.mystery).toEqual({ a: 1 })
  })
  it('смена формата удаляет старый файл шапки, но не обложки', () => {
    const ch = buildCoverChanges('bot', text, webp, ['banners/bot.jpg', 'covers/bot.jpg'], now, 'banner')
    expect(ch).toContainEqual({ path: 'banners/bot.jpg', base64: null })
    expect(ch.find((c) => c.path === 'covers/bot.jpg')).toBeUndefined()
  })
  it('убрать шапку: удаляет оба возможных файла шапки и снимает поле', () => {
    const t = JSON.stringify({ ...JSON.parse(text), banner: 'banners/bot.webp' })
    const ch = buildCoverChanges('bot', t, null, ['banners/bot.webp', 'banners/bot.jpg', 'covers/bot.webp'], now, 'banner')
    expect(ch.filter((c) => 'base64' in c).map((c) => c.path).sort()).toEqual(['banners/bot.jpg', 'banners/bot.webp'])
    const proj = JSON.parse((ch.at(-1) as { text: string }).text)
    expect(proj.banner ?? null).toBeNull()
    expect(proj.cover).toBe('covers/bot.webp')
  })
  it('обложка по умолчанию работает как раньше', () => {
    const ch = buildCoverChanges('bot', text, webp, [], now)
    expect(ch[0]!.path).toBe('covers/bot.webp')
  })
  it('битый файл проекта: понятная ошибка про шапку', () => {
    expect(() => buildCoverChanges('bot', '{', webp, [], now, 'banner')).toThrow(/шапку/)
  })
})
