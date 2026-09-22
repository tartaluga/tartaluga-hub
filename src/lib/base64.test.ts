import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, decodeText, encodeText } from './base64'

describe('base64 для UTF-8', () => {
  const cases = {
    пусто: '',
    латиница: 'Hello, hub',
    кириллица: 'Съешь же ещё этих мягких французских булок — ёж!',
    эмодзи: 'Визор 🦾🐢✨ протогена',
    'JSON с переводами строк': JSON.stringify({ title: 'Тестовый проект', tags: ['тег'] }, null, 2) + '\n',
  }

  for (const [name, text] of Object.entries(cases)) {
    it(`туда и обратно: ${name}`, () => {
      expect(decodeText(encodeText(text))).toBe(text)
    })
  }

  it('совпадает с тем, что отдаёт GitHub (с переводами строк внутри base64)', () => {
    const text = 'Задача'
    const b64 = '0JfQsNC00LDRh9Cw' // эталон: Buffer.from('Задача').toString('base64')
    const withNewlines = b64.slice(0, 4) + '\n' + b64.slice(4) + '\n'
    expect(decodeText(withNewlines)).toBe(text)
    expect(encodeText(text)).toBe(b64)
  })

  it('выдерживает 1 МБ текста', () => {
    const text = 'Тартаруга '.repeat(110_000)
    expect(decodeText(encodeText(text))).toBe(text)
  })

  it('бинарные данные не портятся', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('битый UTF-8 — ошибка, а не тихая порча', () => {
    expect(() => decodeText(bytesToBase64(new Uint8Array([0xff, 0xfe])))).toThrow()
  })
})
