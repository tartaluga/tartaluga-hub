import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../lib/base64'
import { buildCoverChanges } from './coverEdit'

const webp = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), ext: 'webp' as const }
const jpg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), ext: 'jpg' as const }
const project = { schemaVersion: 2, slug: 'bot', title: 'Бот', status: 'active', future: { a: 1 }, createdAt: '2026-09-01T10:00:00+03:00', updatedAt: '2026-09-01T10:00:00+03:00' }
const json = (o: object) => JSON.stringify(o)
const NOW = new Date('2026-10-04T12:00:00Z')

const textOf = (changes: ReturnType<typeof buildCoverChanges>) => JSON.parse((changes.find((c) => c.path === 'projects/bot.json') as { text: string }).text) as Record<string, unknown>

describe('buildCoverChanges', () => {
  it('новая обложка: файл + проект с cover, незнакомые поля сохранены', () => {
    const ch = buildCoverChanges('bot', json(project), webp, ['projects/bot.json'], NOW)
    expect(ch).toHaveLength(2)
    expect(ch[0]).toEqual({ path: 'covers/bot.webp', base64: bytesToBase64(webp.bytes) })
    const p = textOf(ch)
    expect(p.cover).toBe('covers/bot.webp')
    expect(p.future).toEqual({ a: 1 })
    expect(p.updatedAt).not.toBe(project.updatedAt)
  })
  it('замена webp на jpg: старый файл удаляется в том же коммите', () => {
    const ch = buildCoverChanges('bot', json({ ...project, cover: 'covers/bot.webp' }), jpg, ['projects/bot.json', 'covers/bot.webp'], NOW)
    expect(ch.map((c) => c.path)).toEqual(['covers/bot.jpg', 'covers/bot.webp', 'projects/bot.json'])
    expect(ch[1]).toEqual({ path: 'covers/bot.webp', base64: null })
    expect(textOf(ch).cover).toBe('covers/bot.jpg')
  })
  it('замена на то же расширение: старый файл не удаляется', () => {
    const ch = buildCoverChanges('bot', json(project), webp, ['covers/bot.webp'], NOW)
    expect(ch.filter((c) => 'base64' in c && c.base64 === null)).toHaveLength(0)
  })
  it('удаление: оба файла и cover убран, остальное цело', () => {
    const ch = buildCoverChanges('bot', json({ ...project, cover: 'covers/bot.jpg' }), null, ['covers/bot.webp', 'covers/bot.jpg', 'covers/other.webp'], NOW)
    expect(ch.map((c) => c.path).sort()).toEqual(['covers/bot.jpg', 'covers/bot.webp', 'projects/bot.json'])
    const p = textOf(ch)
    expect(p.cover ?? null).toBeNull()
    expect(p.future).toEqual({ a: 1 })
    expect(p.title).toBe('Бот')
  })
  it('чужие обложки не трогает; битый JSON даёт ошибку', () => {
    const ch = buildCoverChanges('bot', json(project), webp, ['covers/other.jpg'], NOW)
    expect(ch.some((c) => c.path === 'covers/other.jpg')).toBe(false)
    expect(() => buildCoverChanges('bot', '{oops', webp, [], NOW)).toThrow(/не читается/)
    expect(() => buildCoverChanges('bot', '[]', webp, [], NOW)).toThrow(/не читается/)
  })
})
