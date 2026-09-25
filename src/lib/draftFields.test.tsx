// @vitest-environment happy-dom
// Мелкие поля тоже переживают обновление хаба (ADR-011 §4): подпись ссылки, имя новой ветки,
// название тега (новое и переименование), строка поиска по проектам.
import 'fake-indexeddb/auto'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../app/session'
import { TagEditor } from '../components/TagEditor'
import type { ProjectPatch } from '../data/editProject'
import { Branches } from '../screens/Branches'
import { Project } from '../screens/Project'
import { Projects } from '../screens/Projects'
import { buildHandoff, resetDrafts, restoreHandoff, saveHandoff, type StateStore } from './drafts'

const api = vi.hoisted(() => ({ createBranch: vi.fn(async (_name: string) => {}) }))
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>()
  return { ...real, listBranches: async () => ({ branches: [] }), createBranch: api.createBranch }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_800_000_000_000
const project = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}
const files = [{ path: 'projects/bot.json', sha: 's1', text: JSON.stringify(project) }]

let root: Root
let host: HTMLElement

beforeEach(() => {
  resetDrafts()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  resetDrafts()
  vi.clearAllMocks()
})

function memoryStore(): StateStore {
  const data = new Map<string, unknown>()
  return {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
  }
}

const render = (ui: ReactNode) => act(async () => root.render(ui))

/** Старая версия пишет handoff и уходит; новая подхватывает запись и рисует экран заново. */
async function update(ui: ReactNode) {
  const store = memoryStore()
  await saveHandoff(store, { route: '#/projects', scrollY: 0, now: NOW, build: 'old' })
  await act(async () => root.unmount())
  resetDrafts()
  await restoreHandoff(store, NOW)
  root = createRoot(host)
  await render(ui)
}

const draftKeys = () => buildHandoff({ route: '#/', scrollY: 0, now: NOW, build: 'x' }).drafts.map((d) => d.key)
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => host.querySelector(`[aria-label="${label}"]`) as T
const byText = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (el: HTMLElement, key: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

describe('подпись ссылки в карточке проекта', () => {
  const saveProject = vi.fn(async (_slug: string, _patch: ProjectPatch) => {})
  const screen = () => (
    <MemoryRouter initialEntries={['/projects/bot']}>
      <Routes>
        <Route path="/projects/:slug" element={<Project />} />
      </Routes>
    </MemoryRouter>
  )

  it('переживает обновление: форма ссылки открыта с подписью; после сохранения черновика нет', async () => {
    useSession.setState({ files, saveProject })
    await render(screen())
    await act(async () => byText('Добавить ссылку').click())
    await type(byLabel<HTMLInputElement>('Подпись'), 'Прод')
    expect(draftKeys()).toEqual(['project:bot:link-label'])

    await update(screen())
    const label = byLabel<HTMLInputElement>('Подпись')
    expect(label?.value).toBe('Прод')

    await type(byLabel<HTMLInputElement>('Адрес или путь'), 'https://example.com')
    await act(async () => label.form!.requestSubmit())
    expect(saveProject).toHaveBeenCalledOnce()
    expect(saveProject.mock.calls[0]![1].links?.[0]).toMatchObject({ value: 'https://example.com', label: 'Прод' })
    expect(byLabel('Подпись')).toBeNull()
    expect(draftKeys()).toEqual([])
  })
})

describe('имя новой ветки', () => {
  it('переживает обновление; после создания ветки черновика нет', async () => {
    const switchBranch = vi.fn(async () => {})
    useSession.setState({ branch: 'main', switchBranch })
    const screen = () => (
      <MemoryRouter>
        <Branches />
      </MemoryRouter>
    )
    await render(screen())
    await type(byLabel<HTMLInputElement>('Имя ветки'), 'redesign-2027')
    expect(draftKeys()).toEqual(['branches:new'])

    await update(screen())
    const input = byLabel<HTMLInputElement>('Имя ветки')
    expect(input.value).toBe('redesign-2027')

    await act(async () => input.form!.requestSubmit())
    expect(api.createBranch).toHaveBeenCalledWith('redesign-2027')
    expect(switchBranch).toHaveBeenCalledWith('redesign-2027')
    expect(byLabel<HTMLInputElement>('Имя ветки').value).toBe('')
    expect(draftKeys()).toEqual([])
  })
})

describe('название тега', () => {
  const tags = [{ id: 'work', name: 'Работа', color: '#6fc2b4' }]
  const onChange = vi.fn(async () => {})
  const editor = () => <TagEditor tags={tags} onChange={onChange} onRemove={async () => {}} />

  it('новый тег: поле снова открыто с текстом; после сохранения черновика нет', async () => {
    await render(editor())
    await act(async () => byText('Новый тег').click())
    await type(byLabel<HTMLInputElement>('Название нового тега'), 'Учёба')
    expect(draftKeys()).toEqual(['settings:new-tag'])

    await update(editor())
    const input = byLabel<HTMLInputElement>('Название нового тега')
    expect(input?.value).toBe('Учёба')

    await press(input, 'Enter')
    expect(onChange).toHaveBeenCalledOnce()
    expect(byLabel('Название нового тега')).toBeNull()
    expect(draftKeys()).toEqual([])
  })

  it('новый тег: отмена тоже убирает черновик', async () => {
    await render(editor())
    await act(async () => byText('Новый тег').click())
    await type(byLabel<HTMLInputElement>('Название нового тега'), 'Учёба')
    await press(byLabel('Название нового тега'), 'Escape')
    expect(draftKeys()).toEqual([])
  })

  it('переименование: поле открыто с недописанным названием; после сохранения черновика нет', async () => {
    await render(editor())
    await act(async () => byLabel('Название тега «Работа»: Работа. Изменить').click())
    await type(byLabel<HTMLInputElement>('Название тега «Работа»'), 'Работа и учёба')
    expect(draftKeys()).toEqual(['settings:tag:work:name'])

    await update(editor())
    const input = byLabel<HTMLInputElement>('Название тега «Работа»')
    expect(input?.value).toBe('Работа и учёба')

    await press(input, 'Enter')
    expect(onChange).toHaveBeenCalledOnce()
    expect(draftKeys()).toEqual([])
  })
})

describe('строка поиска по проектам', () => {
  let search = ''
  function Where() {
    search = useLocation().search
    return null
  }
  const screen = () => (
    <MemoryRouter initialEntries={['/projects']}>
      <Projects />
      <Where />
    </MemoryRouter>
  )

  it('экран не вернулся — поиск открыт с текстом и фильтрует; закрыл поиск — черновика нет', async () => {
    useSession.setState({ files, branch: 'main' })
    await render(screen())
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Поиск по проектам"]')!.click())
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Поиск по проектам"]')!, 'бот')
    expect(draftKeys()).toEqual(['projects:search'])

    await update(screen())
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Поиск по проектам"]')
    expect(input?.value).toBe('бот')
    expect(new URLSearchParams(search).get('q')).toBe('бот')
    expect(draftKeys()).toEqual(['projects:search'])

    await act(async () => byLabel('Закрыть поиск').click())
    expect(host.querySelector('input[aria-label="Поиск по проектам"]')).toBeNull()
    expect(draftKeys()).toEqual([])
  })

  it('экран вернулся со своим запросом — черновик его не перебивает', async () => {
    useSession.setState({ files, branch: 'main' })
    await render(screen())
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Поиск по проектам"]')!.click())
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Поиск по проектам"]')!, 'бот')
    await update(
      <MemoryRouter initialEntries={['/projects?q=%D1%85%D0%B0%D0%B1']}>
        <Projects />
        <Where />
      </MemoryRouter>,
    )
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Поиск по проектам"]')?.value).toBe('хаб')
  })
})
