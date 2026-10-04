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
const X = '01K5Y0000000000000000000CC'
const M = '01K5Y0000000000000000000MM'
const C1 = '01K5Y0000000000000000000C1'
const C2 = '01K5Y0000000000000000000C2'

const c1 = { id: C1, at: '2026-10-02T10:00:00+03:00', text: 'Первый' }
const c2 = { id: C2, at: '2026-10-03T10:00:00+03:00', text: 'Второй', author: 'claude' }

const base = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  tasks: [
    { id: A, title: 'Сдать главу', done: false, comments: [c1, c2] },
    { id: B, title: 'Вторая', done: false },
    { id: X, title: 'Третья', done: true, doneAt: '2026-10-01T10:00:00+03:00' },
  ],
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}
const withTask = (idx: number, extra: object) => ({ ...base, tasks: base.tasks.map((t, i) => (i === idx ? { ...t, ...extra } : t)) })

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

function setFiles(data: object, saveProject?: SaveFn) {
  useSession.setState({ files: [{ path: 'projects/bot.json', sha: 's1', text: JSON.stringify(data) }], ...(saveProject ? { saveProject } : {}) })
}

async function open(path: string, saveProject: SaveFn = vi.fn(async () => {}), data: object = base) {
  setFiles(data, saveProject)
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}

const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => host.querySelector(`[aria-label="${label}"]`) as T
const allByLabel = <T extends HTMLElement = HTMLElement>(label: string) => [...host.querySelectorAll(`[aria-label="${label}"]`)] as T[]
const buttonText = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

async function typeArea(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const ctrlEnter = (el: HTMLElement) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))

describe('маршрут задачи: граничные случаи', () => {
  it('id нужной формы, но такой задачи нет — «Задача не найдена» со ссылкой на проект', async () => {
    await open('/projects/bot/tasks/01K5Y0000000000000000000ZZ')
    expect(host.textContent).toContain('Задача не найдена')
    expect([...host.querySelectorAll('a[href="/projects/bot"]')].map((a) => a.textContent).join()).toContain('«Бот»')
  })

  it('id в нижнем регистре — «Задача не найдена»', async () => {
    await open(`/projects/bot/tasks/${A.toLowerCase()}`)
    expect(host.textContent).toContain('Задача не найдена')
  })

  it('id слишком короткий — не падает', async () => {
    await open('/projects/bot/tasks/01K5Y')
    expect(host.textContent).toContain('Задача не найдена')
  })

  it('проекта нет — пояснение, а не «Задача не найдена»', async () => {
    await open(`/projects/nope/tasks/${A}`)
    expect(host.textContent).toContain('Такого проекта нет')
    expect(host.textContent).not.toContain('Задача не найдена')
  })

  it('задачу удалили с другого устройства, пока страница открыта, — страница переходит в «не найдена»', async () => {
    await open(`/projects/bot/tasks/${B}`)
    expect(host.querySelector('h1')?.textContent).toContain('Вторая')
    setFiles({ ...base, tasks: base.tasks.filter((t) => t.id !== B) })
    await act(async () => {})
    expect(host.textContent).toContain('Задача не найдена')
  })

  it('ошибка сохранения при удалении задачи: переход в карточку не происходит', async () => {
    const save = vi.fn<SaveFn>(async () => {
      throw new Error('сбой записи')
    })
    await open(`/projects/bot/tasks/${B}`, save)
    await act(async () => buttonText('Удалить задачу').click())
    expect(host.querySelector('h1')?.textContent).toContain('Вторая')
    expect(buttonText('Удалить задачу').disabled).toBe(false)
  })

  // БАГ (найден тестировщиком): пока удаление «в полёте», задача пропадает из показанных данных, TaskBody
  // размонтируется, а после отказа монтируется заново с пустым состоянием — причина ошибки не видна.
  it.fails('ошибка сохранения при удалении задачи: остаёмся на странице и видим причину', async () => {
    const save = vi.fn<SaveFn>(async () => {
      throw new Error('сбой записи')
    })
    await open(`/projects/bot/tasks/${B}`, save)
    await act(async () => buttonText('Удалить задачу').click())
    expect(save).toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('статус задачи и лог', () => {
  const run = async (idx: number, extra: object, label: string) => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${base.tasks[idx]!.id}`, save, withTask(idx, extra))
    await act(async () => buttonText(label).click())
    return save
  }

  it('к выполнению → «Готово»: done, doneAt, метки сняты, запись «готово»', async () => {
    const save = await run(0, {}, 'Готово')
    const patch = save.mock.calls[0]![1]
    expect(patch.taskSet).toEqual([{ id: A, done: true, inProgress: null, cancelled: null, doneAt: expect.stringMatching(/^\d{4}-/) }])
    expect(patch.logAdd).toHaveLength(1)
    expect(patch.logAdd![0]).toMatchObject({ kind: 'task', taskId: A, text: '«Сдать главу»: готово' })
  })

  it('«В работе» → «Готово» убирает метку работы и ставит doneAt', async () => {
    const save = await run(0, { inProgress: true }, 'Готово')
    expect(save.mock.calls[0]![1].taskSet![0]).toMatchObject({ done: true, inProgress: null, doneAt: expect.any(String) })
  })

  it('готово → «К выполнению»: done=false, doneAt снят, запись «снова к выполнению»', async () => {
    const save = await run(2, {}, 'К выполнению')
    const patch = save.mock.calls[0]![1]
    expect(patch.taskSet).toEqual([{ id: X, done: false, inProgress: null, cancelled: null, doneAt: null }])
    expect(patch.logAdd![0]!.text).toBe('«Третья»: снова к выполнению')
  })

  it('готово → «Отменена»: doneAt не меняется', async () => {
    const save = await run(2, {}, 'Отменена')
    const patch = save.mock.calls[0]![1]
    expect(patch.taskSet![0]).toMatchObject({ done: true, cancelled: true })
    expect(patch.taskSet![0]).not.toHaveProperty('doneAt')
    expect(patch.logAdd![0]!.text).toBe('«Третья»: отменена')
  })

  it('отменена → «Готово»: метка cancelled снимается, doneAt не меняется', async () => {
    const save = await run(2, { cancelled: true }, 'Готово')
    const patch = save.mock.calls[0]![1]
    expect(patch.taskSet![0]).toMatchObject({ done: true, cancelled: null })
    expect(patch.taskSet![0]).not.toHaveProperty('doneAt')
    expect(patch.logAdd![0]!.text).toBe('«Третья»: готово')
  })

  it('нажатие на текущий статус ничего не пишет (в том числе «Отменена» у отменённой)', async () => {
    const save = await run(2, { cancelled: true }, 'Отменена')
    expect(save).not.toHaveBeenCalled()
  })

  it('нажатой выглядит «Отменена» у done+cancelled', async () => {
    await open(`/projects/bot/tasks/${X}`, vi.fn(async () => {}), withTask(2, { cancelled: true }))
    expect(buttonText('Отменена').getAttribute('aria-pressed')).toBe('true')
    expect(buttonText('Готово').getAttribute('aria-pressed')).toBe('false')
  })

  it('нажатой выглядит «В работе» у задачи с inProgress', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}), withTask(0, { inProgress: true }))
    expect(buttonText('В работе').getAttribute('aria-pressed')).toBe('true')
  })

  it('ошибка сохранения статуса показывается', async () => {
    const save = vi.fn<SaveFn>(async () => {
      throw new Error('нет сети')
    })
    await open(`/projects/bot/tasks/${A}`, save)
    await act(async () => buttonText('В работе').click())
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('отменённая задача вне прогресса (карточка проекта)', () => {
  it('из трёх одна отменена: «1/2», не 1/3 и не 2/3', async () => {
    // A к выполнению, B отменена, X готова.
    await open('/projects/bot', vi.fn(async () => {}), withTask(1, { done: true, cancelled: true, doneAt: '2026-10-01T10:00:00+03:00' }))
    expect(host.textContent).toContain('1/2')
    expect(host.textContent).not.toContain('2/3')
    expect(host.textContent).not.toContain('1/3')
  })

  it('все задачи отменены — прогресса нет, «0/0» не показывается', async () => {
    const all = { ...base, tasks: base.tasks.map((t) => ({ ...t, done: true, cancelled: true })) }
    await open('/projects/bot', vi.fn(async () => {}), all)
    expect(host.textContent).not.toContain('0/0')
    expect(host.textContent).not.toMatch(/\d\/3/)
  })

  it('в списке у отменённой метка «отменена», у выполняемой — «в работе»', async () => {
    const data = { ...base, tasks: [{ ...base.tasks[0]!, inProgress: true }, { ...base.tasks[1]!, done: true, cancelled: true }, base.tasks[2]!] }
    await open('/projects/bot', vi.fn(async () => {}), data)
    const text = host.textContent ?? ''
    expect(text).toContain('отменена')
    expect(text).toContain('в работе')
  })
})

describe('комментарии: правка и удаление', () => {
  it('порядок по времени, а не по порядку в файле', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}), withTask(0, { comments: [c2, c1] }))
    const items = [...host.querySelectorAll('ol li')].map((li) => li.textContent ?? '')
    expect(items[0]).toContain('Первый')
    expect(items[1]).toContain('Второй')
  })

  it('правка: меняется только text и ставится editedAt; соседний комментарий и author не тронуты', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    const edit = allByLabel('Изменить комментарий')
    expect(edit).toHaveLength(2)
    await act(async () => edit[1]!.click())
    const area = byLabel<HTMLTextAreaElement>('Комментарий')
    expect(area.value).toBe('Второй')
    await typeArea(area, 'Второй, исправлено')
    await ctrlEnter(area)
    expect(save).toHaveBeenCalledTimes(1)
    const comments = save.mock.calls[0]![1].taskSet![0]!.comments!
    expect(comments).toHaveLength(2)
    expect(comments.find((c) => c.id === C1)).toEqual(c1)
    expect(comments.find((c) => c.id === C2)).toEqual({ ...c2, text: 'Второй, исправлено', editedAt: expect.any(String) })
  })

  it('Esc при правке не сохраняет', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    await act(async () => allByLabel('Изменить комментарий')[0]!.click())
    const area = byLabel<HTMLTextAreaElement>('Комментарий')
    await typeArea(area, 'Другое')
    await act(async () => void area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(save).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Первый')
  })

  it('удаление одного из двух: второй остаётся, поле comments не обнуляется', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    await act(async () => allByLabel('Удалить комментарий')[0]!.click())
    expect(save).toHaveBeenCalledWith('bot', { taskSet: [{ id: A, comments: [c2] }] })
  })

  it('отказ в подтверждении не удаляет комментарий', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    await act(async () => allByLabel('Удалить комментарий')[0]!.click())
    expect(save).not.toHaveBeenCalled()
  })

  it('пустой комментарий и из пробелов не отправляются', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save)
    const area = byLabel<HTMLTextAreaElement>('Текст комментария')
    expect(byLabel<HTMLButtonElement>('Отправить комментарий').disabled).toBe(true)
    await typeArea(area, '   \n ')
    expect(byLabel<HTMLButtonElement>('Отправить комментарий').disabled).toBe(true)
    await ctrlEnter(area)
    expect(save).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(area.value.trim()).toBe('')
  })

  it('Ctrl+Enter отправляет, обычный Enter — нет', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${B}`, save)
    const area = byLabel<HTMLTextAreaElement>('Текст комментария')
    await typeArea(area, 'Раз')
    await act(async () => void area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(save).not.toHaveBeenCalled()
    await ctrlEnter(area)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![1].taskSet![0]!.comments).toHaveLength(1)
  })

  it('не сохранилось: текст возвращается в поле, показана ошибка', async () => {
    const save = vi.fn<SaveFn>(async () => {
      throw new Error('сбой')
    })
    await open(`/projects/bot/tasks/${B}`, save)
    await typeArea(byLabel<HTMLTextAreaElement>('Текст комментария'), 'Не потерять')
    await act(async () => byLabel('Отправить комментарий').click())
    expect(byLabel<HTMLTextAreaElement>('Текст комментария').value).toBe('Не потерять')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('комментарий не исполняет сырой HTML', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}), withTask(0, { comments: [{ ...c1, text: '<img src=x onerror=alert(1)> **жирно**' }] }))
    await vi.waitFor(() => expect(host.querySelector('strong')?.textContent).toBe('жирно'), { timeout: 20_000 })
    expect(host.querySelector('img')).toBeNull()
  }, 30_000)
})

describe('только просмотр: полный обход', () => {
  const ro = { ...base, schemaVersion: 99, milestones: [{ id: M, title: 'Релиз' }] }

  it('нет ни одной кнопки правки, комментарии и статус видны', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}), ro)
    expect(allByLabel('Изменить комментарий')).toHaveLength(0)
    expect(allByLabel('Удалить комментарий')).toHaveLength(0)
    expect(byLabel('Изменить срок задачи')).toBeNull()
    expect(byLabel('Задать срок задачи')).toBeNull()
    expect(byLabel('Отправить комментарий')).toBeNull()
    expect(buttonText('Добавить описание')).toBeUndefined()
    expect(buttonText('Удалить задачу')).toBeUndefined()
    for (const s of ['К выполнению', 'В работе', 'Готово', 'Отменена']) expect(buttonText(s).disabled).toBe(true)
    expect(host.textContent).toContain('Первый')
    expect(host.textContent).toContain('Второй')
  })

  it('клик по заблокированному статусу ничего не сохраняет', async () => {
    const save = vi.fn<SaveFn>(async () => {})
    await open(`/projects/bot/tasks/${A}`, save, ro)
    await act(async () => buttonText('Готово').click())
    expect(save).not.toHaveBeenCalled()
  })

  it('веха — текст, а не выпадающий список', async () => {
    await open(`/projects/bot/tasks/${A}`, vi.fn(async () => {}), { ...ro, tasks: [{ ...ro.tasks[0]!, milestoneId: M }, ...ro.tasks.slice(1)] })
    expect(byLabel('Веха задачи')).toBeNull()
    expect(host.textContent).toContain('Релиз')
  })
})
