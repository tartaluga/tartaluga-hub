// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READ_ONLY, useSession } from '../app/session'
import { ApiError } from '../lib/api'
import { buildHandoff } from '../lib/drafts'
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

describe('карточка проекта: правка отклонена (вкладка уступила запись, ADR-013)', () => {
  const refused = async () => {
    throw new ApiError(423, 'read_only', READ_ONLY)
  }
  const typeInto = async (el: HTMLTextAreaElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const handoffTexts = () => buildHandoff({ route: '#/', scrollY: 0, now: 0, build: 't' }).drafts.map((d) => d.text)

  it('описание: набранное остаётся в поле и в черновиках (уедет в handoff), под полем — почему не сохранено', async () => {
    await open(refused)
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Добавить описание'))!
    await act(async () => add.click())
    const area = byLabel<HTMLTextAreaElement>('Описание')
    await typeInto(area, 'длинный набранный текст')
    await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))
    expect(byLabel<HTMLTextAreaElement>('Описание').value).toBe('длинный набранный текст')
    expect(host.textContent).toContain(READ_ONLY)
    expect(handoffTexts()).toContain('длинный набранный текст')
  })

  it('лог: запись не сохранилась — текст вернулся в поле', async () => {
    await open(refused)
    const area = byLabel<HTMLTextAreaElement>('Текст записи')
    await typeInto(area, 'что сделано')
    await act(async () => area.form!.requestSubmit())
    expect(byLabel<HTMLTextAreaElement>('Текст записи').value).toBe('что сделано')
    expect(host.textContent).toContain(READ_ONLY)
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

describe('карточка проекта: закрепление', () => {
  it('кнопка закрепляет через saveProject и сразу показывает новое состояние', async () => {
    let finish!: () => void
    const saveProject = vi.fn((_slug: string, _patch: ProjectPatch) => new Promise<void>((r) => (finish = r)))
    await open(saveProject)
    const pin = byLabel<HTMLButtonElement>('Закрепить')
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    await act(async () => pin.click())
    expect(saveProject).toHaveBeenCalledWith('bot', { pinned: true })
    expect(byLabel('Открепить').getAttribute('aria-pressed')).toBe('true')
    await act(async () => finish())
  })

  it('закреплённый открепляется: поле убирается', async () => {
    const saveProject = vi.fn(async (_slug: string, _patch: ProjectPatch) => {})
    await open(saveProject, undefined, { ...project, pinned: true })
    await act(async () => byLabel<HTMLButtonElement>('Открепить').click())
    expect(saveProject).toHaveBeenCalledWith('bot', { pinned: null })
  })

  it('в файле новой версии кнопки нет', async () => {
    await open(async () => {}, undefined, { ...project, schemaVersion: 99, pinned: true })
    expect(byLabel('Открепить')).toBeNull()
    expect(byLabel('Закрепить')).toBeNull()
  })
})
