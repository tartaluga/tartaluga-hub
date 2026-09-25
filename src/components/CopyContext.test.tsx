// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../schema/types'
import { CopyContext } from './CopyContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: Project = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'paused',
  nextStep: 'Шаг',
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}

let root: Root
let host: HTMLElement
const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function setClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText ? { writeText } : undefined })
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<CopyContext project={project} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  if (original) Object.defineProperty(navigator, 'clipboard', original)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Скопировать контекст'))!

describe('CopyContext', () => {
  it('копирует контекст в буфер и говорит «Скопировано»', async () => {
    const writeText = vi.fn(async (_t: string) => {})
    setClipboard(writeText)
    const status = host.querySelector('[role="status"]')!
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')
    await act(async () => button().click())
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0]?.[0]).toContain('# Проект: Бот')
    expect(writeText.mock.calls[0]?.[0]).toContain('- Статус: пауза')
    expect(status.textContent).toBe('Скопировано')
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('при отказе буфера показывает текст в диалоге для ручного копирования', async () => {
    setClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    await act(async () => button().click())
    const dialog = host.querySelector('dialog')!
    expect(dialog).not.toBeNull()
    const area = dialog.querySelector('textarea')!
    expect(area.readOnly).toBe(true)
    expect(area.value).toContain('- Следующий шаг: Шаг')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('')
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Закрыть"]')!.click())
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('без API буфера тоже открывает диалог', async () => {
    setClipboard(undefined)
    await act(async () => button().click())
    expect(host.querySelector('dialog textarea')).not.toBeNull()
  })
})
