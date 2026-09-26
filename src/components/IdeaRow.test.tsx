import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { DeleteIdeaConfirm, IdeaRow } from './IdeaRow'
import { firstLine, type IdeaView } from '../data/ideas'
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

const view = (text: string, project: string | null = null, readOnly = false): IdeaView => ({
  path: 'ideas/01J8Z6Y0000000000000000001.json',
  id: '01J8Z6Y0000000000000000001',
  data: { schemaVersion: 1, id: '01J8Z6Y0000000000000000001', text, createdAt: '2026-09-20T10:00:00+03:00', ...(project ? { project } : {}) },
  readOnly,
  reason: readOnly ? 'формат новее сборки' : null,
  title: firstLine(text),
  project,
  projectTitle: project ? 'Хаб' : null,
})

const openRow = (idea: IdeaView) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <IdeaRow idea={idea} projects={[{ slug: 'hub', title: 'Хаб', status: 'active' }]} taken={['hub']} open onToggle={() => {}} />
    </MemoryRouter>,
  )

const count = (html: string, s: string) => html.split(s).length - 1

describe('IdeaRow раскрытая', () => {
  it('однострочный текст не повторяется под заголовком: вместо него «Изменить текст»', () => {
    const html = openRow(view('Светящиеся уши'))
    expect(count(html, 'Светящиеся уши')).toBe(1 + 1) // заголовок + aria-label кнопки правки
    expect(html).not.toMatch(/>Светящиеся уши<\/button>[\s\S]*>Светящиеся уши</)
    expect(html).toContain('Изменить текст')
  })

  it('многострочный текст показан целиком под заголовком', () => {
    const html = openRow(view('Режим фокуса\nподробности'))
    expect(html).toContain('подробности')
    expect(html).not.toContain('Изменить текст')
  })

  it('только чтение: совпадающий текст не дублируется', () => {
    const html = openRow(view('Светящиеся уши', null, true))
    expect(count(html, 'Светящиеся уши')).toBe(1)
  })

  it('«Сделать проектом» есть у идеи без проекта', () => {
    expect(openRow(view('Идея'))).toContain('Сделать проектом')
  })

  it('длинная однострочная идея: в раскрытой строке заголовок целиком и без обрезки', () => {
    const long = 'Очень длинная идея '.repeat(20).trim()
    for (const ro of [false, true]) {
      const html = openRow(view(long, null, ro))
      expect(html).toMatch(new RegExp(`aria-expanded="true"[^>]*>${long}<`))
    }
  })

  it('«Сделать проектом» снова есть, если привязанный проект удалён', () => {
    const html = openRow({ ...view('Идея', 'gone'), projectTitle: null })
    expect(html).toContain('Сделать проектом')
  })

  it('«Сделать проектом» скрыто, если идея уже привязана к проекту', () => {
    const html = openRow(view('Идея', 'hub'))
    expect(html).toMatch(/<option value="hub" selected="">Хаб<\/option>/)
    expect(html).not.toContain('Сделать проектом')
  })
})
