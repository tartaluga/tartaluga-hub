// @vitest-environment happy-dom
// Вкладка просмотра (ADR-013): поля не принимают текст, поиск работает, после отмены поля снова живые.
import { afterEach, describe, expect, it } from 'vitest'
import { lockInputs } from './readOnlyInputs'

afterEach(() => {
  document.body.innerHTML = ''
})

function field(html: string): HTMLInputElement | HTMLTextAreaElement {
  document.body.insertAdjacentHTML('beforeend', html)
  return document.body.lastElementChild as HTMLInputElement | HTMLTextAreaElement
}

describe('lockInputs', () => {
  it('поле, получившее фокус, становится readOnly; после отмены — снова принимает ввод', () => {
    const unlock = lockInputs(document)
    const input = field('<input>')
    const area = field('<textarea></textarea>')
    const date = field('<input type="date">')
    input.focus()
    area.focus()
    date.focus()
    expect([input.readOnly, area.readOnly, date.readOnly]).toEqual([true, true, true])
    unlock()
    expect([input.readOnly, area.readOnly, date.readOnly]).toEqual([false, false, false])
  })

  it('поле, в фокусе до включения, тоже запирается', () => {
    const input = field('<input>')
    input.focus()
    const unlock = lockInputs(document)
    expect(input.readOnly).toBe(true)
    unlock()
    expect(input.readOnly).toBe(false)
  })

  it('поиск и флажки не трогает; поле, которое уже было readOnly, после отмены остаётся readOnly', () => {
    const unlock = lockInputs(document)
    const search = field('<input type="search">')
    const box = field('<input type="checkbox">')
    const shown = field('<textarea readonly></textarea>')
    search.focus()
    box.focus()
    shown.focus()
    expect(search.readOnly).toBe(false)
    expect(box.readOnly).toBe(false)
    unlock()
    expect(shown.readOnly).toBe(true)
  })

  it('после отмены новые поля не запираются', () => {
    lockInputs(document)()
    const input = field('<input>')
    input.focus()
    expect(input.readOnly).toBe(false)
  })
})
