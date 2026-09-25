import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteIdeaConfirm } from './IdeaRow'
import source from './IdeaRow.tsx?raw'

describe('DeleteIdeaConfirm', () => {
  it('подтверждение внутри страницы: название идеи, «Удалить идею» и «Отмена»', () => {
    const html = renderToStaticMarkup(<DeleteIdeaConfirm title="Бот <b>пар</b>" onConfirm={() => {}} onCancel={() => {}} />)
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Удаление идеи «Бот &lt;b&gt;пар&lt;/b&gt;»"')
    expect(html).toContain('Удалить идею «Бот &lt;b&gt;пар&lt;/b&gt;»?')
    expect(html).not.toContain('<b>')
    expect(html).toMatch(/<button[^>]*>Удалить идею<\/button>/)
    expect(html).toMatch(/<button[^>]*>Отмена<\/button>/)
  })

  it('строка идеи не использует системное окно confirm', () => {
    expect(source).not.toMatch(/window\.confirm|\bconfirm\(/)
  })
})
