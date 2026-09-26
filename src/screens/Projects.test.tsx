import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { MAIN } from '../app/session'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { EMPTY_FILTER } from '../data/projects'
import { EmptyLibrary, NothingFound, Projects } from './Projects'

// Серверный рендер zustand берёт начальное состояние стора, поэтому стор подменяем простым объектом.
const mockState = vi.hoisted(() => ({ files: [] as { path: string; sha: string; text: string }[], branch: 'main', tree: null }))
vi.mock('../app/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../app/session')>()
  const useSession = Object.assign((sel: (s: typeof mockState) => unknown) => sel(mockState), { getState: () => mockState })
  return { ...real, useSession }
})
const setState = (next: Partial<typeof mockState>) => Object.assign(mockState, next)

let n = 0
function project(slug: string, extra: object = {}) {
  n++
  return {
    path: `projects/${slug}.json`,
    sha: `sha${n}`,
    text: JSON.stringify({
      schemaVersion: 1,
      slug,
      title: `Проект ${slug}`,
      status: 'active',
      createdAt: '2026-09-01T10:00:00+03:00',
      updatedAt: '2026-09-01T10:00:00+03:00',
      ...extra,
    }),
  }
}

function render(url = '/projects') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Projects />
    </MemoryRouter>,
  )
}

const count = (html: string, s: string) => html.split(s).length - 1

beforeEach(() => {
  setState({ files: [], branch: MAIN })
})

describe('Projects: проектов нет', () => {
  it('ПК — плитка «Первый проект» с пояснением и три пустых места; телефон — заголовок и кнопка', () => {
    const html = render()
    expect(html).toContain('0 проектов')
    expect(html).toContain('Достаточно названия. Остальное — статус, шаг, ссылки — можно добавить потом.')
    expect(html).toContain('Проектов пока нет')
    expect(html).toContain('Начни с названия — остальное добавишь потом.')
    expect(html).toContain('Первый проект')
    expect(html).not.toContain(' Новый проект</button>')
    expect(html).not.toContain('Ничего не нашлось')
  })

  it('не в main — говорит о ветке', () => {
    setState({ branch: 'опыт' })
    const html = render()
    expect(html).toContain('В ветке «опыт» проектов нет')
    expect(html).not.toContain('Проектов пока нет')
  })
})

describe('Projects: ничего не нашлось по фильтру', () => {
  it('по статусу — своя подсказка и сброс фильтров', () => {
    setState({ files: [project('a')] })
    const html = render('/projects?status=paused')
    expect(html).toContain('Ничего не нашлось')
    expect(html).toContain('Проектов с этим статусом нет.')
    expect(html).toContain('Сбросить фильтры')
    expect(html).toContain(' Новый проект</button>')
    expect(html).not.toContain('Первый проект')
  })

  it('поиск при непустом архиве — подсказка про вкладку «Архив»', () => {
    setState({ files: [project('a'), project('b', { status: 'archived' })] })
    const html = render('/projects?q=zzz&status=all')
    expect(html).toContain('Архив в поиск не входит — открой вкладку «Архив».')
  })

  it('поиск во вкладке, выбранной явно, — подсказка открыть «Все»', () => {
    setState({ files: [project('a'), project('b', { status: 'archived' })] })
    expect(render('/projects?q=zzz&status=active')).toContain('Поиск идёт только по выбранному статусу — открой вкладку «Все».')
  })

  it('поиск при вкладке по умолчанию идёт по всем, кроме архива (подсказка про архив)', () => {
    setState({ files: [project('a'), project('b', { status: 'archived' })] })
    expect(render('/projects?q=zzz')).toContain('Архив в поиск не входит — открой вкладку «Архив».')
  })

  it('поиск при вкладке по умолчанию находит проект на паузе', () => {
    setState({ files: [project('a'), project('p', { status: 'paused' }), project('x', { status: 'archived' })] })
    const html = render('/projects?q=%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82')
    expect(html).toContain('Проект p')
    expect(html).toContain('Проект a')
    expect(html).not.toContain('Проект x')
  })

  it('поиск без архива — общая подсказка', () => {
    setState({ files: [project('a')] })
    expect(render('/projects?q=zzz&status=all')).toContain('Попробуй другой запрос или сбрось фильтры.')
  })
})

describe('Projects: фильтр по умолчанию', () => {
  const files = () => [project('a'), project('b', { status: 'paused' })]
  const pressed = (html: string, label: string) => new RegExp(`aria-pressed="true"[^>]*>${label}<`).test(html)

  it('без status в адресе — вкладка «В работе», только проекты в работе, без «Сбросить фильтры»', () => {
    setState({ files: files() })
    const html = render()
    expect(pressed(html, 'В работе')).toBe(true)
    expect(pressed(html, 'Все')).toBe(false)
    expect(html).toContain('Проект a')
    expect(html).not.toContain('Проект b')
    expect(html).not.toContain('Сбросить фильтры')
  })

  it('явно выбранная «Все» (status=all) сохраняется в адресе и показывает все', () => {
    setState({ files: files() })
    const html = render('/projects?status=all')
    expect(pressed(html, 'Все')).toBe(true)
    expect(html).toContain('Проект a')
    expect(html).toContain('Проект b')
    expect(html).not.toContain('Сбросить фильтры')
  })

  it('в работе нет ни одного — «Ничего не нашлось» со сбросом', () => {
    setState({ files: [project('b', { status: 'paused' })] })
    const html = render()
    expect(html).toContain('Проектов с этим статусом нет.')
    expect(html).toContain('Сбросить фильтры')
  })
})

describe('Projects: список', () => {
  it('давно тихий проект: подпись тишины и на обложке (ПК), и в строке (телефон)', () => {
    setState({ files: [project('a')] })
    expect(count(render(), 'data-tone="quiet"')).toBe(2)
  })

  it('у строки есть подпись активности для телефона рядом с подписью для ПК', () => {
    const now = new Date().toISOString()
    setState({ files: [project('a', { nextStep: 'Шаг', createdAt: now, updatedAt: now })] })
    const html = render()
    expect(html).toContain('Проект a')
    // Статус словом: на плашке обложки (ПК) и скрытой подписью строки (телефон, для скринридера).
    expect(count(html, '>в работе</span>')).toBe(2)
    expect(count(html, 'title="Последняя активность"')).toBe(2)
    expect(html).toContain('→ Шаг')
    expect(html).not.toContain('Ничего не нашлось')
    expect(html).not.toContain('Первый проект')
  })
})

// DOM-окружения (jsdom/happy-dom) в проекте нет: кнопки ищем в дереве элементов компонента без хуков и жмём их обработчик.
type Props = { children?: ReactNode; onClick?: () => void }
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<Props>(node)) return textOf(node.props.children)
  return ''
}
function buttons(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, out))
  else if (isValidElement<Props>(node)) {
    if (node.type === 'button') out.push(node)
    buttons(node.props.children, out)
  }
  return out
}
const click = (tree: ReactNode, label: string) => {
  const found = buttons(tree).filter((b) => textOf(b).includes(label))
  expect(found.length).toBeGreaterThan(0)
  found.forEach((b) => b.props.onClick?.())
  return found.length
}

describe('Пустые состояния: кнопки', () => {
  it('«Первый проект» (и плитка ПК, и кнопка телефона) открывает создание', () => {
    const onCreate = vi.fn()
    const n = click(EmptyLibrary({ branch: MAIN, onCreate }), 'Первый проект')
    expect(onCreate).toHaveBeenCalledTimes(n)
  })

  it('«Сбросить фильтры» сбрасывает фильтр', () => {
    const onReset = vi.fn()
    click(NothingFound({ filter: { ...EMPTY_FILTER, query: 'x' }, archived: 0, onReset }), 'Сбросить фильтры')
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('подсказка — живая область, а не весь блок', () => {
    const html = renderToStaticMarkup(<NothingFound filter={{ ...EMPTY_FILTER, query: 'x' }} archived={0} onReset={() => {}} />)
    expect(html).toMatch(/<p [^>]*role="status"[^>]*>Попробуй/)
    expect(count(html, 'role="status"')).toBe(1)
  })
})
