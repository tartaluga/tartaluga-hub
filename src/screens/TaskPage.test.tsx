// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../app/session'
import { Project } from './Project'
import { TaskPage } from './TaskPage'
import type { ProjectPatch } from '../data/editProject'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = '01K5Y0000000000000000000AA'
const B = '01K5Y0000000000000000000BB'
const M = '01K5Y0000000000000000000MM'
const C1 = '01K5Y0000000000000000000C1'
const C2 = '01K5Y0000000000000000000C2'

const project = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  milestones: [{ id: M, title: 'Релиз' }],
  tasks: [
    {
      id: A,
      title: 'Сдать главу',
      done: false,
      due: '2099-09-21',
      originalDue: '2099-09-21',
      milestoneId: M,
      description: 'Снять **листы**',
      links: [{ id: '01K5Y0000000000000000000K1', kind: 'site', value: 'https://example.com/x', label: 'Схема' }],
      comments: [
        { id: C1, at: '2026-10-02T10:00:00+03:00', text: 'Первый' },
        { id: C2, at: '2026-10-03T10:00:00+03:00', text: 'Сделал X', author: 'claude', editedAt: '2026-10-03T11:00:00+03:00' },
      ],
    },
    { id: B, title: 'Вторая', done: false },
  ],
  log: [{ id: '01K5Y0000000000000000000G1', at: '2026-10-03T10:00:00+03:00', kind: 'task', taskId: A, text: '«Сдать главу»: в работе' }],
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.confirm = vi.fn(() => true)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

type SaveFn = (slug: string, patch: ProjectPatch) => Promise<void>

async function open(path: string, saveProject: SaveFn = vi.fn(async () => {}), data: object = project) {
  useSession.setState({ files: [{ path: 'projects/bot.json', sha: 's1', text: JSON.stringify(data) }], saveProject })
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:slug" element={<Project />} />
          <Route path="/projects/:slug/tasks/:taskId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  // Markdown грузится отдельным чанком.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}

const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => host.querySelector(`[aria-label="${label}"]`) as T
const buttonText = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

async function typeArea(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('страница задачи', () => {
  it('показывает название, статус, срок, веху, описание, ссылки и комментарии по порядку', async () => {
    await open(`/projects/bot/tasks/${A}`)
    expect(host.querySelector('h1')?.textContent).toContain('Сдать главу')
    expect(buttonText('К выполнению').getAttribute('aria-pressed')).toBe('true')
    expect(host.textContent).toContain('21.09.2099')
    expect((byLabel<HTMLSelectElement>('Веха задачи')).value).toBe(M)
    await vi.waitFor(() => expect(host.querySelector('strong')?.textContent).toBe('листы'), { timeout: 20_000 })
    expect(host.querySelector('a[href="https://example.com/x"]')?.textContent).toBe('Схема')
    const comments = [...host.querySelectorAll('ol li')].map((li) => li.textContent)
    expect(comments).toHaveLength(2)
    expect(comments[0]).toContain('Первый')
    expect(comments[1]).toContain('Сделал X')
    expect(comments[1]).toContain('Claude')
    expect(comments[1]).toContain('изменено')
    expect(comments[0]).not.toContain('Claude')
  }, 30_000)

  it('неверный id и несуществующая задача — «Задача не найдена» со ссылкой на проект, не NotFound', async () => {
    await open('/projects/bot/tasks/not-an-id')
    expect(host.textContent).toContain('Задача не найдена')
    expect(host.querySelector('a[href="/projects/bot"]')).not.toBeNull()
    await open('/projects/bot/tasks/01K5Y0000000000000000000ZZ')
    expect(host.textContent).toContain('Задача не найдена')
  })

  it('статус «В работе»: правка задачи и запись лога одним сохранением', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    await act(async () => buttonText('В работе').click())
    expect(save).toHaveBeenCalledWith('bot', {
      taskSet: [{ id: A, done: false, inProgress: true, cancelled: null, doneAt: null }],
      logAdd: [expect.objectContaining({ kind: 'task', taskId: A, text: '«Сдать главу»: в работе' })],
    })
    // Тот же статус повторно не пишется.
    save.mockClear()
    await act(async () => buttonText('К выполнению').click())
    expect(save).not.toHaveBeenCalled()
  })

  it('«Отменена» ставит done и cancelled', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    await act(async () => buttonText('Отменена').click())
    expect(save.mock.calls[0]![1]).toMatchObject({ taskSet: [{ id: A, done: true, cancelled: true, inProgress: null }], logAdd: [{ text: '«Сдать главу»: отменена' }] })
  })

  it('веха: перенос в «Без вехи»', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    const sel = byLabel<HTMLSelectElement>('Веха задачи')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, '')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(save).toHaveBeenCalledWith('bot', { taskSet: [{ id: A, milestoneId: null }] })
  })

  it('новый комментарий уходит с ULID и временем, без author; поле очищается', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    const area = byLabel<HTMLTextAreaElement>('Текст комментария')
    await typeArea(area, '  Новое  ')
    await act(async () => byLabel('Отправить комментарий').click())
    const patch = save.mock.calls[0]![1] as ProjectPatch
    const comments = patch.taskSet![0]!.comments!
    expect(comments).toHaveLength(3)
    expect(comments[2]).toEqual({ id: expect.stringMatching(/^[0-9A-Z]{26}$/), at: expect.any(String), text: 'Новое' })
    expect(area.value).toBe('')
  })

  it('карандаш только у своих комментариев; у комментария Claude его нет, удаление есть', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}))
    const items = [...host.querySelectorAll('ol li')]
    expect(items[0]!.querySelector('[aria-label="Изменить комментарий"]')).not.toBeNull()
    expect(items[1]!.textContent).toContain('Сделал X')
    expect(items[1]!.querySelector('[aria-label="Изменить комментарий"]')).toBeNull()
    expect(items[1]!.querySelector('[aria-label="Удалить комментарий"]')).not.toBeNull()
  })

  it('удаление комментария — с подтверждением; последний убран — поле уходит (comments: null)', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    const one = { ...project, tasks: [{ ...project.tasks[0]!, comments: [project.tasks[0]!.comments![0]!] }, project.tasks[1]!] }
    await open(`/projects/bot/tasks/${A}`, save, one)
    await act(async () => byLabel('Удалить комментарий').click())
    expect(window.confirm).toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith('bot', { taskSet: [{ id: A, comments: null }] })
  })

  it('удалить задачу: подтверждение, taskRemove, переход в карточку проекта', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${B}`, save)
    await act(async () => buttonText('Удалить задачу').click())
    expect(save).toHaveBeenCalledWith('bot', { taskRemove: [B] })
    expect(host.querySelector('h1')?.textContent).toBe('Бот')
  })

  it('отказ подтверждения не удаляет', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${B}`, save)
    await act(async () => buttonText('Удалить задачу').click())
    expect(save).not.toHaveBeenCalled()
  })

  it('только просмотр (файл новой версии формата): ни карандашей, ни кнопок правки', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}), { ...project, schemaVersion: 99 })
    expect(host.querySelector('h1')?.textContent).toContain('Сдать главу')
    expect(byLabel('Изменить Название задачи')).toBeNull()
    expect(byLabel('Текст комментария')).toBeNull()
    expect(byLabel('Удалить комментарий')).toBeNull()
    expect(buttonText('Удалить задачу')).toBeUndefined()
    expect(buttonText('В работе').disabled).toBe(true)
    expect(byLabel('Веха задачи')).toBeNull()
  })

  it('название задачи в карточке ведёт на страницу задачи; запись лога о задаче — тоже', async () => {
    await open('/projects/bot')
    const title = host.querySelector(`a[href="/projects/bot/tasks/${A}"]`)
    expect(title?.textContent).toBe('Сдать главу')
    // У задачи с описанием, ссылкой и комментариями в списке есть значки.
    expect(host.querySelector('[aria-label="Есть описание"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Есть ссылки"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Комментариев: 2"]')).not.toBeNull()
    const logLink = [...host.querySelectorAll(`a[href="/projects/bot/tasks/${A}"]`)].find((a) => a.textContent?.includes('в работе'))
    expect(logLink).toBeDefined()
    await act(async () => (title as HTMLAnchorElement).click())
    expect(host.querySelector('h1')?.textContent).toContain('Сдать главу')
    expect(host.textContent).toContain('Комментарии')
  })

  it('запись лога об удалённой задаче показывается без ссылки', async () => {
    const gone = { ...project, log: [{ id: '01K5Y0000000000000000000G2', at: '2026-10-03T10:00:00+03:00', kind: 'task', taskId: '01K5Y0000000000000000000ZZ', text: '«Старая»: готово' }] }
    await open('/projects/bot', vi.fn(async () => {}), gone)
    expect(host.textContent).toContain('«Старая»: готово')
    expect(host.querySelector('a[href*="ZZ"]')).toBeNull()
  })
})
