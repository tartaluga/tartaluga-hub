import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { MAIN } from '../app/session'
import { Projects } from './Projects'

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
    expect(count(html, 'aria-hidden="true"></li>')).toBe(3)
    expect(html).toContain('Проектов пока нет')
    expect(html).toContain('Начни с названия — остальное добавишь потом.')
    // Две кнопки создания (плитка на ПК, кнопка на телефоне; CSS показывает одну), в шапке кнопки нет.
    expect(count(html, 'Первый проект</')).toBe(2)
    expect(html).not.toContain(' Новый проект</button>')
    expect(html).not.toContain('Ничего не нашлось')
  })

  it('не в main — говорит о ветке', () => {
    setState({ branch: 'опыт' })
    const html = render()
    expect(html).toContain('В ветке «опыт» проектов нет')
    expect(html).toContain('data-branch=""')
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
    const html = render('/projects?q=zzz')
    expect(html).toContain('Архив в поиск не входит — открой вкладку «Архив».')
  })

  it('поиск без архива — общая подсказка', () => {
    setState({ files: [project('a')] })
    expect(render('/projects?q=zzz')).toContain('Попробуй другой запрос или сбрось фильтры.')
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
    expect(count(html, 'title="Последняя активность"')).toBe(2)
    expect(html).toContain('→ Шаг')
    expect(html).not.toContain('Ничего не нашлось')
    expect(html).not.toContain('Первый проект')
  })
})
