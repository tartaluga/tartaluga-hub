// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEdit, StoredConflict } from '../lib/localdb'

const snap = vi.hoisted(() => ({ edits: [] as unknown[], conflicts: [] as unknown[] }))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  unsentSnapshot: () => ({ edits: [...snap.edits], conflicts: [...snap.conflicts] }),
  installSyncTriggers: () => () => undefined,
}))
vi.mock('../data/unsentExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/unsentExport')>()),
  buildUnsentExport: vi.fn((edits: unknown[], conflicts: unknown[]) => ({ edits, conflicts })),
  downloadJson: vi.fn(),
}))

const { useSession } = await import('./session')
const { answerSignOut, confirmDataLoss, downloadUnsent, guardedSignOut, unsentCounts, unsentMessage, useSignOutGuard } = await import('./signOutGuard')
const { downloadJson } = await import('../data/unsentExport')
const { SignOutGuardDialog } = await import('../components/SignOutGuardDialog')
const { Shell } = await import('./Shell')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const edit = (path: string) => ({ branch: 'main', path }) as unknown as QueuedEdit
const conflict = (items: number, branch = 'idea') => ({ branch, path: 'projects/a.json', items: Array(items).fill({}) }) as unknown as StoredConflict

let root: Root
let host: HTMLElement

beforeEach(() => {
  snap.edits = []
  snap.conflicts = []
  useSignOutGuard.setState({ ask: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  answerSignOut(false)
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

const buttonText = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
const click = (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error('нет кнопки')
    ;(el as HTMLElement).click()
  })

describe('signOutGuard: подсчёт и текст', () => {
  it('считает правки и спорные места конфликтов по всем веткам', () => {
    snap.edits = [edit('projects/a.json'), edit('projects/b.json')]
    snap.conflicts = [conflict(2, 'main'), conflict(0, 'idea')]
    expect(unsentCounts()).toEqual({ edits: 2, conflicts: 3 })
  })

  it('текст: обе части, одна часть, склонения', () => {
    expect(unsentMessage({ edits: 2, conflicts: 1 })).toBe('2 неотправленные правки и 1 конфликт сотрутся с этого устройства.')
    expect(unsentMessage({ edits: 1, conflicts: 0 })).toBe('1 неотправленная правка сотрётся с этого устройства.')
    expect(unsentMessage({ edits: 0, conflicts: 5 })).toBe('5 конфликтов сотрутся с этого устройства.')
    expect(unsentMessage({ edits: 11, conflicts: 0 })).toBe('11 неотправленных правок сотрутся с этого устройства.')
  })
})

describe('signOutGuard: решение', () => {
  it('пусто — выход сразу, без вопроса', async () => {
    const signOut = vi.fn(async () => undefined)
    await expect(guardedSignOut(signOut)).resolves.toBe(true)
    expect(signOut).toHaveBeenCalledOnce()
    expect(useSignOutGuard.getState().ask).toBeNull()
  })

  it('есть конфликт — signOut не вызван, пока нет «Стереть и выйти»', async () => {
    snap.conflicts = [conflict(1)]
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await Promise.resolve()
    expect(useSignOutGuard.getState().ask).toMatchObject({ scope: 'device', counts: { edits: 0, conflicts: 1 } })
    expect(signOut).not.toHaveBeenCalled()
    downloadUnsent()
    await Promise.resolve()
    expect(signOut).not.toHaveBeenCalled()
    answerSignOut(true)
    await expect(done).resolves.toBe(true)
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('«Отмена» — signOut не вызван', async () => {
    snap.edits = [edit('projects/a.json')]
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    answerSignOut(false)
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('второй вопрос поверх открытого закрывает первый отказом', async () => {
    snap.edits = [edit('projects/a.json')]
    const first = confirmDataLoss('device')
    const second = confirmDataLoss('everywhere')
    await expect(first).resolves.toBe('cancel')
    expect(useSignOutGuard.getState().ask?.scope).toBe('everywhere')
    answerSignOut(true)
    await expect(second).resolves.toBe('erase')
  })

  it('«Скачать» берёт свежий снимок', () => {
    snap.edits = [edit('projects/a.json')]
    downloadUnsent(new Date(2026, 8, 29, 14, 30))
    expect(downloadJson).toHaveBeenCalledWith('hub-unsent-2026-09-29-1430.json', { edits: snap.edits, conflicts: [] })
  })
})

describe('SignOutGuardDialog', () => {
  it('пусто — диалога нет; с конфликтами — текст, «Скачать» не выходит, выход по «Стереть и выйти»', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    expect(host.querySelector('dialog')).toBeNull()

    snap.edits = [edit('projects/a.json')]
    snap.conflicts = [conflict(2)]
    const signOut = vi.fn(async () => undefined)
    let done!: Promise<boolean>
    await act(async () => {
      done = guardedSignOut(signOut)
    })
    const dialog = host.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('1 неотправленная правка и 2 конфликта сотрутся с этого устройства.')
    expect(dialog.textContent).toContain('Выйти с этого устройства?')

    await click(buttonText('Скачать неотправленное'))
    expect(downloadJson).toHaveBeenCalledOnce()
    expect(dialog.textContent).toContain('Файл скачан')
    expect(signOut).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)

    await click(buttonText('Стереть и выйти'))
    await done
    expect(signOut).toHaveBeenCalledOnce()
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('Esc и «Отмена» — не выходим', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    snap.conflicts = [conflict(1)]
    const signOut = vi.fn(async () => undefined)
    let done!: Promise<boolean>
    await act(async () => {
      done = guardedSignOut(signOut)
    })
    await act(async () => {
      host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    await expect(done).resolves.toBe(false)

    await act(async () => {
      done = guardedSignOut(signOut)
    })
    await click(buttonText('Отмена'))
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('«Выйти везде» — свой заголовок и строка про другие устройства', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    snap.edits = [edit('projects/a.json')]
    await act(async () => {
      void confirmDataLoss('everywhere')
    })
    expect(host.textContent).toContain('Выйти на всех устройствах?')
    expect(host.textContent).toContain('Входы на других устройствах тоже завершатся.')
  })
})

describe('Shell: кнопка «Выйти» идёт через страж', () => {
  const renderShell = (signOut: () => Promise<void>) => {
    useSession.setState({ phase: 'ready', sync: 'idle', files: [], conflicts: [], queued: 0, me: null, boot: vi.fn(async () => undefined), signOut })
    return act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/stats']}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/stats" element={<p>экран</p>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    )
  }
  const shellButton = () => host.querySelector('button[aria-label="Выйти"]')

  it('конфликт в другой ветке — диалог, signOut только после «Стереть и выйти»', async () => {
    snap.conflicts = [conflict(1, 'idea')]
    const signOut = vi.fn(async () => undefined)
    await renderShell(signOut)
    await click(shellButton())
    expect(signOut).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="signout-guard-title"]')?.open).toBe(true)
    await click(buttonText('Стереть и выйти'))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('пусто — выход сразу', async () => {
    const signOut = vi.fn(async () => undefined)
    await renderShell(signOut)
    await click(shellButton())
    expect(signOut).toHaveBeenCalledOnce()
  })
})
