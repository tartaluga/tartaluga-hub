import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UpdateNoticeView } from './UpdateNotice'

const noop = () => {}
const view = (status: 'idle' | 'updating' | 'deferred', rescue: string | null, copied = false) =>
  renderToStaticMarkup(<UpdateNoticeView status={status} rescue={rescue} copied={copied} onCopy={noop} onDismiss={noop} />)

describe('UpdateNotice: плашки «Обновить» нет (ADR-011)', () => {
  it('обычная работа и само обновление — ничего не показывается', () => {
    expect(view('idle', null)).toBe('')
    expect(view('updating', null)).toBe('')
  })

  it('обновление отложено защитой от петли — «правки сохранены на устройстве», без кнопки «Обновить»', () => {
    const html = view('deferred', null)
    expect(html).toContain('Хаб обновляется, правки сохранены на устройстве')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('Обновить<')
  })

  it('черновик не перенесён — текст для копирования, экранирован (данные не становятся разметкой)', () => {
    const html = view('idle', 'Описание\n<img src=x onerror=alert(1)>')
    expect(html).toContain('Не удалось перенести черновик')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(html).toContain('readOnly=""')
    expect(html).toContain('Скопировать')
  })

  it('после копирования кнопка говорит «Скопировано»', () => {
    expect(view('idle', 'т', true)).toContain('Скопировано')
  })
})
