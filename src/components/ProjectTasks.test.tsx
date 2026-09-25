// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectPatch } from '../data/editProject'
import type { Task } from '../schema/types'
import { ProjectTasks } from './ProjectTasks'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TODAY = new Date(2026, 8, 23, 12)
const A = '01K5Y0000000000000000000AA'
const B = '01K5Y0000000000000000000BB'
const tasks: Task[] = [
  { id: A, title: 'Сдать главу', done: false, due: '2026-09-25', originalDue: '2026-09-21' },
  { id: B, title: 'Макет', done: false, due: '2026-09-22' },
]

let root: Root
let host: HTMLElement
let save: ReturnType<typeof vi.fn<(p: ProjectPatch) => Promise<string | null>>>

async function render(list: Task[], readOnly = false) {
  await act(async () => root.render(<ProjectTasks tasks={list} readOnly={readOnly} save={save} today={TODAY} />))
}

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T & Element>(sel) as unknown as T
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => q<T>(`[aria-label="${label}"]`)
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!

async function click(el: Element) {
  await act(async () => (el as HTMLElement).click())
}

/** Ввод в управляемое поле React: значение через нативный сеттер, затем событие input. */
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(el: Element, k: string) {
  await act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
}

async function submit(form: HTMLFormElement) {
  await act(async () => form.requestSubmit())
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  save = vi.fn(async () => null)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('ProjectTasks', () => {
  it('список: счётчик, подписи сроков, просрочка помечена, перенос виден', async () => {
    await render([...tasks, { id: '01K5Y0000000000000000000CC', title: 'Готово', done: true }])
    expect(q('h2').textContent).toBe('Задачи · 1/3')
    const rows = host.querySelectorAll('li')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('перенесено с 21.09')
    expect(rows[0]!.hasAttribute('data-overdue')).toBe(false)
    expect(rows[1]!.hasAttribute('data-overdue')).toBe(true)
    expect(rows[1]!.textContent).toContain('−1 дн · 22.09')
    expect(rows[1]!.textContent).not.toContain('перенесено')
    expect(rows[2]!.hasAttribute('data-done')).toBe(true)
  })

  it('пустой список — подсказка; только чтение — без кнопок правки', async () => {
    await render([])
    expect(host.textContent).toContain('Задач пока нет')
    await render(tasks, true)
    expect(byLabel('Новая задача')).toBeNull()
    expect(byLabel('Удалить задачу Макет')).toBeNull()
    expect(byLabel<HTMLButtonElement>('Сделано: Макет').disabled).toBe(true)
  })

  it('отметка «сделано» сохраняет done и doneAt', async () => {
    await render(tasks)
    await click(byLabel('Сделано: Макет'))
    expect(save).toHaveBeenCalledWith({ taskSet: [{ id: B, done: true, doneAt: expect.any(String) }] })
  })

  it('добавить задачу со сроком: поля очищаются; при ошибке ввод возвращается и видна причина', async () => {
    await render(tasks)
    const add = byLabel<HTMLButtonElement>('Добавить задачу')
    expect(add.disabled).toBe(true)
    await type(byLabel('Новая задача'), 'Релиз v0.3')
    await type(byLabel('Срок новой задачи'), '2026-09-26')
    await submit(add.form!)
    const patch = save.mock.calls[0]![0]
    expect(patch.taskAdd).toEqual([{ id: expect.any(String), title: 'Релиз v0.3', done: false, due: '2026-09-26' }])
    expect(byLabel<HTMLInputElement>('Новая задача').value).toBe('')

    save.mockResolvedValueOnce('Нет связи')
    await type(byLabel('Новая задача'), 'Вторая')
    await submit(add.form!)
    expect(byLabel<HTMLInputElement>('Новая задача').value).toBe('Вторая')
    expect(q('[role="alert"]').textContent).toBe('Нет связи')
  })

  it('перенос срока: форма, Enter сохраняет новую дату', async () => {
    await render(tasks)
    await click(byLabel('Срок: −1 дн · 22.09. Изменить срок'))
    const field = byLabel<HTMLInputElement>('Срок задачи')
    expect(field.value).toBe('2026-09-22')
    await type(field, '2026-09-30')
    await submit(field.form!)
    expect(save).toHaveBeenCalledWith({ taskSet: [{ id: B, due: '2026-09-30' }] })
    expect(byLabel('Срок задачи')).toBeNull()
  })

  it('снять срок — due: null; Esc закрывает без записи; та же дата не пишется', async () => {
    await render(tasks)
    await click(byLabel('Срок: −1 дн · 22.09. Изменить срок'))
    await key(byLabel('Срок задачи'), 'Escape')
    expect(byLabel('Срок задачи')).toBeNull()
    await click(byLabel('Срок: −1 дн · 22.09. Изменить срок'))
    await submit(byLabel<HTMLInputElement>('Срок задачи').form!)
    expect(save).not.toHaveBeenCalled()
    await click(byLabel('Срок: −1 дн · 22.09. Изменить срок'))
    await click(button('Без срока'))
    expect(save).toHaveBeenCalledWith({ taskSet: [{ id: B, due: null }] })
  })

  it('задать срок задаче без срока: кнопки «Без срока» нет', async () => {
    await render([{ id: A, title: 'Без даты', done: false }])
    await click(byLabel('Задать срок'))
    expect(host.textContent).not.toContain('Без срока')
    await type(byLabel('Срок задачи'), '2026-10-01')
    await click(button('Сохранить'))
    expect(save).toHaveBeenCalledWith({ taskSet: [{ id: A, due: '2026-10-01' }] })
  })

  it('удаление — после подтверждения; отказ ничего не пишет', async () => {
    await render(tasks)
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true })
    await click(byLabel('Удалить задачу Макет'))
    expect(save).not.toHaveBeenCalled()
    await click(byLabel('Удалить задачу Макет'))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledWith({ taskRemove: [B] })
  })

  it('правка названия на месте: Enter сохраняет', async () => {
    await render(tasks)
    await click(button('Макет'))
    const field = byLabel<HTMLInputElement>('Название задачи')
    await type(field, 'Макет меню')
    await key(field, 'Enter')
    expect(save).toHaveBeenCalledWith({ taskSet: [{ id: B, title: 'Макет меню' }] })
  })
})
