// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEdit, StoredConflict } from '../lib/localdb'

// Память вкладки подменена; IndexedDB настоящая (fake-indexeddb), её чтение можно уронить.
const snap = vi.hoisted(() => ({ edits: [] as unknown[], conflicts: [] as unknown[] }))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  unsentSnapshot: () => ({ edits: [...snap.edits], conflicts: [...snap.conflicts] }),
  installSyncTriggers: () => () => undefined,
}))
vi.mock('../lib/localdb', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/localdb')>()
  return { ...real, getQueue: vi.fn(real.getQueue), getConflicts: vi.fn(real.getConflicts) }
})
vi.mock('../data/unsentExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/unsentExport')>()),
  buildUnsentExport: vi.fn((edits: unknown[], conflicts: unknown[]) => ({ edits, conflicts })),
  downloadJson: vi.fn(),
}))

const { useSession } = await import('./session')
const { answerSignOut, confirmDataLoss, downloadUnsent, guardedSignOut, unsentCounts, unsentMessage, useSignOutGuard } = await import('./signOutGuard')
const { downloadJson } = await import('../data/unsentExport')
const localdb = await import('../lib/localdb')
const { SignOutGuardDialog, OTHER_TABS } = await import('../components/SignOutGuardDialog')
const { Shell } = await import('./Shell')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const edit = (path: string, branch = 'main') => ({ branch, path }) as unknown as QueuedEdit
const conflict = (items: number, branch = 'idea') => ({ branch, path: 'projects/a.json', items: Array(items).fill({}) }) as unknown as StoredConflict
const dbEdit = (path: string): QueuedEdit => ({
  branch: 'main',
  path,
  baseSha: 's1',
  baseText: '{}',
  patch: { title: 'Б' },
  text: '{}',
  queuedAt: '2026-09-29T10:00:00+03:00',
})

let root: Root
let host: HTMLElement

beforeEach(async () => {
  snap.edits = []
  snap.conflicts = []
  await localdb.wipeDevice()
  useSession.setState({ deviceError: null })
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
/** Дождаться открытого вопроса стража (он появляется после чтения IndexedDB). */
const asked = (scope?: string) =>
  act(() =>
    vi.waitFor(() => {
      const ask = useSignOutGuard.getState().ask
      if (!ask || (scope && ask.scope !== scope)) throw new Error('вопроса нет')
    }),
  )

describe('signOutGuard: подсчёт и текст', () => {
  it('считает правки и спорные места конфликтов по всем веткам', async () => {
    snap.edits = [edit('projects/a.json'), edit('projects/b.json')]
    snap.conflicts = [conflict(2, 'main'), conflict(0, 'idea')]
    await expect(unsentCounts()).resolves.toEqual({ edits: 2, conflicts: 3, unknown: false })
  })

  it('память пуста, в IndexedDB есть правка — она посчитана; то же в памяти и в базе — один раз', async () => {
    await localdb.putQueued(dbEdit('projects/a.json'))
    await expect(unsentCounts()).resolves.toEqual({ edits: 1, conflicts: 0, unknown: false })
    snap.edits = [edit('projects/a.json'), edit('projects/a.json', 'idea')]
    await expect(unsentCounts()).resolves.toEqual({ edits: 2, conflicts: 0, unknown: false })
  })

  it('чтение IndexedDB упало или у устройства ошибка — «не удалось проверить»', async () => {
    vi.mocked(localdb.getQueue).mockRejectedValueOnce(new Error('сломано'))
    await expect(unsentCounts()).resolves.toEqual({ edits: 0, conflicts: 0, unknown: true })
    useSession.setState({ deviceError: 'Не удалось прочитать очередь правок с устройства' })
    await expect(unsentCounts()).resolves.toMatchObject({ unknown: true })
  })

  it('текст: обе части, одна часть, склонения, неизвестно', () => {
    expect(unsentMessage({ edits: 2, conflicts: 1 })).toBe('2 неотправленные правки и 1 конфликт сотрутся с этого устройства.')
    expect(unsentMessage({ edits: 1, conflicts: 0 })).toBe('1 неотправленная правка сотрётся с этого устройства.')
    expect(unsentMessage({ edits: 0, conflicts: 5 })).toBe('5 конфликтов сотрутся с этого устройства.')
    expect(unsentMessage({ edits: 11, conflicts: 0 })).toBe('11 неотправленных правок сотрутся с этого устройства.')
    expect(unsentMessage({ edits: 0, conflicts: 0, unknown: true })).toBe('Не удалось проверить, что на устройстве: неотправленные правки и конфликты, если они есть, сотрутся.')
    expect(unsentMessage({ edits: 1, conflicts: 0, unknown: true })).toBe('1 неотправленная правка сотрётся с этого устройства. Не удалось проверить, что на устройстве — может быть и больше.')
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
    await asked()
    expect(useSignOutGuard.getState().ask).toMatchObject({ scope: 'device', counts: { edits: 0, conflicts: 1 } })
    expect(signOut).not.toHaveBeenCalled()
    await downloadUnsent()
    expect(signOut).not.toHaveBeenCalled()
    answerSignOut(true)
    await expect(done).resolves.toBe(true)
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('память пуста, правка только в IndexedDB — вопрос, без согласия не выходим', async () => {
    await localdb.putQueued(dbEdit('projects/a.json'))
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await asked()
    expect(useSignOutGuard.getState().ask?.counts).toEqual({ edits: 1, conflicts: 0, unknown: false })
    answerSignOut(false)
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('чтение IndexedDB бросает — вопрос даже при пустой памяти', async () => {
    vi.mocked(localdb.getConflicts).mockRejectedValueOnce(new Error('заблокировано'))
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await asked()
    expect(useSignOutGuard.getState().ask?.counts).toMatchObject({ edits: 0, conflicts: 0, unknown: true })
    answerSignOut(false)
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('битая запись конфликта без items — считается за один, диалог показан', async () => {
    vi.mocked(localdb.getConflicts).mockResolvedValueOnce([{ branch: 'main', path: 'projects/b.json' } as unknown as StoredConflict])
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await asked()
    expect(useSignOutGuard.getState().ask?.counts).toMatchObject({ edits: 0, conflicts: 1 })
    answerSignOut(false)
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('IndexedDB не отвечает (заблокирована) — по таймауту вопрос', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(localdb.getQueue).mockReturnValueOnce(new Promise(() => undefined))
      const answer = confirmDataLoss('device')
      await vi.advanceTimersByTimeAsync(3000)
      expect(useSignOutGuard.getState().ask?.counts.unknown).toBe(true)
      answerSignOut(false)
      await expect(answer).resolves.toBe('cancel')
    } finally {
      vi.useRealTimers()
    }
  })

  it('«Отмена» — signOut не вызван', async () => {
    snap.edits = [edit('projects/a.json')]
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await asked()
    answerSignOut(false)
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('второй вопрос поверх открытого закрывает первый отказом', async () => {
    snap.edits = [edit('projects/a.json')]
    const first = confirmDataLoss('device')
    await asked('device')
    const second = confirmDataLoss('everywhere')
    await expect(first).resolves.toBe('cancel')
    expect(useSignOutGuard.getState().ask?.scope).toBe('everywhere')
    answerSignOut(true)
    await expect(second).resolves.toBe('erase')
  })

  it('«Скачать» берёт свежий снимок памяти и IndexedDB', async () => {
    snap.edits = [edit('projects/a.json')]
    const stored = dbEdit('projects/b.json')
    await localdb.putQueued(stored)
    await downloadUnsent(new Date(2026, 8, 29, 14, 30))
    expect(downloadJson).toHaveBeenCalledWith('hub-unsent-2026-09-29-1430.json', { edits: [snap.edits[0], { ...stored, kind: 'project' }], conflicts: [] })
  })
})

describe('SignOutGuardDialog', () => {
  it('пусто — диалога нет; с конфликтами — текст, «Скачать» не выходит, выход по «Стереть и выйти»', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    expect(host.querySelector('dialog')).toBeNull()

    snap.edits = [edit('projects/a.json')]
    snap.conflicts = [conflict(2)]
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await asked()
    const dialog = host.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('1 неотправленная правка и 2 конфликта сотрутся с этого устройства.')
    expect(dialog.textContent).toContain('Выйти с этого устройства?')
    expect(dialog.textContent).toContain(OTHER_TABS)
    expect(OTHER_TABS).toMatch(/другой вкладке, закрой её сначала — её неотправленные правки тоже сотрутся/)

    await click(buttonText('Скачать неотправленное'))
    await act(() => vi.waitFor(() => expect(dialog.textContent).toContain('Файл скачан')))
    expect(downloadJson).toHaveBeenCalledOnce()
    expect(signOut).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)

    await click(buttonText('Стереть и выйти'))
    await done
    expect(signOut).toHaveBeenCalledOnce()
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('чтение устройства не удалось — «не удалось проверить», выход только по «Стереть и выйти»', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    vi.mocked(localdb.getQueue).mockRejectedValueOnce(new Error('сломано'))
    const signOut = vi.fn(async () => undefined)
    const done = guardedSignOut(signOut)
    await asked()
    expect(host.textContent).toContain('Не удалось проверить, что на устройстве')
    expect(signOut).not.toHaveBeenCalled()
    await click(buttonText('Стереть и выйти'))
    await done
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('снимок при скачивании неизвестен — «может быть неполным»', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    snap.edits = [edit('projects/a.json')]
    const done = guardedSignOut(vi.fn(async () => undefined))
    await asked()
    vi.mocked(localdb.getQueue).mockRejectedValueOnce(new Error('сломано'))
    await click(buttonText('Скачать неотправленное'))
    await act(() => vi.waitFor(() => expect(host.querySelector('dialog')!.textContent).toContain('он может быть неполным')))
    answerSignOut(false)
    await done
  })

  it('Esc и «Отмена» — не выходим', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    snap.conflicts = [conflict(1)]
    const signOut = vi.fn(async () => undefined)
    let done = guardedSignOut(signOut)
    await asked()
    await act(async () => {
      host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    await expect(done).resolves.toBe(false)

    done = guardedSignOut(signOut)
    await asked()
    await click(buttonText('Отмена'))
    await expect(done).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('«Выйти везде» — свой заголовок и строка про другие устройства', async () => {
    await act(async () => root.render(<SignOutGuardDialog />))
    snap.edits = [edit('projects/a.json')]
    void confirmDataLoss('everywhere')
    await asked()
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
    await asked()
    expect(signOut).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="signout-guard-title"]')?.open).toBe(true)
    await click(buttonText('Стереть и выйти'))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('пусто — выход сразу', async () => {
    const signOut = vi.fn(async () => undefined)
    await renderShell(signOut)
    await click(shellButton())
    await act(() => vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce()))
    expect(useSignOutGuard.getState().ask).toBeNull()
  })
})
