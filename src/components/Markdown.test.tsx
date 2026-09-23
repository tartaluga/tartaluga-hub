import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown описания: недоверенный ввод', () => {
  it('обычная разметка работает, ссылки https открываются в новой вкладке', () => {
    const out = html('**жирный**\n\n- пункт\n\n[сайт](https://bot.dev)')
    expect(out).toContain('<strong>жирный</strong>')
    expect(out).toContain('<li>пункт</li>')
    expect(out).toContain('<a href="https://bot.dev/" target="_blank" rel="noopener noreferrer">сайт</a>')
  })

  it('javascript:, data:, vscode: и прочие схемы ссылкой не становятся', () => {
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vscode://x/y', '//evil.com', 'mailto:a@b.c']) {
      const out = html(`[x](${url}) <${url}>`)
      expect(out).not.toContain('href')
    }
  })

  it('сырой HTML выбрасывается, картинки не грузятся', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\ntext <b onclick="x">b</b>\n\n![схема](https://evil.com/t.png)')
    expect(out).not.toMatch(/<script|<img|onerror|onclick|<b /)
    expect(out).toContain('[схема]')
    expect(out).not.toContain('evil.com')
  })
})
