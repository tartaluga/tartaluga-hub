// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../app/session'
import type { ProjectPatch } from '../data/editProject'
import { Project } from './Project'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = '01K5Y0000000000000000000AA'
const project = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  tasks: [{ id: A, title: 'Сдать главу', done: false, due: '2099-09-21', originalDue: '2099-09-21' }],
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}

let root: Root
let host: HTMLElement

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function open(saveProject: (slug: string, patch: ProjectPatch) => Promise<void>, state?: unknown, data: object = project) {
  useSession.setState({ files: [{ path: 'projects/bot.json', sha: 's1', text: JSON.stringify(data) }], saveProject })
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[{ pathname: '/projects/bot', state }]}>
        <Routes>
          <Route path="/projects/:slug" element={<Project />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
}

const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => host.querySelector(`[aria-label="${label}"]`) as T

async function setDate(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('карточка проекта: задачи', () => {
  it('перенос срока сразу виден с пометкой «перенесено с …» — первый срок ставит normalizeProject', async () => {
    let finish: () => void = () => {}
    const saveProject = vi.fn((_slug: string, _patch: ProjectPatch) => new Promise<void>((r) => (finish = r)))
    await open(saveProject)
    expect([...host.querySelectorAll('h2')].find((h) => h.textContent?.startsWith('Задачи'))?.textContent).toBe('Задачи · 0/1')
    expect(host.textContent).not.toContain('перенесено')

    await act(async () => byLabel('Срок: 21.09.2099. Изменить срок').click())
    const field = byLabel<HTMLInputElement>('Срок задачи')
    await setDate(field, '2099-09-28')
    await act(async () => field.form!.requestSubmit())

    expect(saveProject).toHaveBeenCalledWith('bot', { taskSet: [{ id: A, due: '2099-09-28' }] })
    // Сервер ещё не ответил, а на экране уже прежний срок как «перенесено с»; форма срока ждёт ответа.
    expect(host.textContent).toContain('перенесено с 21.09.2099')
    await act(async () => finish())
    // Запись подтверждена — форма закрылась (файл в сессии мок не меняет, поэтому дальше виден прежний срок).
    expect(byLabel('Срок задачи')).toBeNull()
  })

  it('ошибка записи откатывает показанную правку и видна под блоком задач', async () => {
    await open(async () => {
      throw new Error('сломалось')
    })
    await act(async () => byLabel('Сделано: Сдать главу').click())
    expect(byLabel('Сделано: Сдать главу').getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('section section [role="alert"]')?.textContent).toBe('Что-то пошло не так. Попробуй ещё раз.')
  })
})

describe('карточка проекта: описание', () => {
  it('описание — сразу под названием, выше задач; правка на месте открывается', async () => {
    await open(async () => {})
    const titles = [...host.querySelectorAll('h1, h2')].map((h) => h.textContent)
    expect(titles[0]).toContain('Бот')
    expect(titles.indexOf('Описание')).toBeGreaterThan(0)
    expect(titles.indexOf('Описание')).toBeLessThan(titles.findIndex((t) => t?.startsWith('Задачи')))
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Добавить описание'))!
    await act(async () => add.click())
    expect(byLabel('Описание').tagName).toBe('TEXTAREA')
  })
})

describe('карточка проекта: шапка', () => {
  const backHref = () => host.querySelector('a')!.getAttribute('href')

  it('«Проекты» ведёт на фильтр списка, с которого открыли карточку', async () => {
    await open(async () => {}, { listSearch: '?status=all' })
    expect(backHref()).toBe('/projects?status=all')
  })

  it('без фильтра или с чужим state — просто список', async () => {
    await open(async () => {}, { listSearch: '//evil.example' })
    expect(backHref()).toBe('/projects')
  })

  it('плашка «только чтение» — выше описания', async () => {
    await open(async () => {}, undefined, { ...project, schemaVersion: 99 })
    const html = host.innerHTML
    expect(html).toContain('Здесь только чтение.')
    expect(html.indexOf('Здесь только чтение.')).toBeLessThan(html.indexOf('>Описание<'))
  })
})
