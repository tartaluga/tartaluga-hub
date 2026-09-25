import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STATE_VERSION } from '../app/migrations'
import {
  buildHandoff,
  clearDraft,
  discardRestoredDraft,
  dismissRescue,
  FAILED_KEY,
  getRescue,
  HANDOFF_KEY,
  idbStateStore,
  parseHandoff,
  resetDrafts,
  restoredDraft,
  restoreHandoff,
  rescueText,
  safeRoute,
  saveHandoff,
  SCREEN_TTL_MS,
  setDraft,
  useDraft,
  useDraftText,
  wipeDrafts,
  type StateStore,
} from './drafts'

function memoryStore(init: Record<string, unknown> = {}): StateStore & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(init))
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
  }
}

const NOW = 1_800_000_000_000
const save = (store: StateStore, route = '#/projects/hub', scrollY = 420, now = NOW) => saveHandoff(store, { route, scrollY, now, build: 'old' })

beforeEach(() => {
  resetDrafts()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('handoff: старая версия пишет, новая читает', () => {
  it('черновики, экран и прокрутка переезжают; запись удаляется', async () => {
    const store = memoryStore()
    setDraft('project:hub:summary', 'Хаб · описание', 'новый текст')
    setDraft('new-project:title', 'Новый проект · название', 'Идея')
    await save(store)
    resetDrafts() // «перезагрузка»

    const r = await restoreHandoff(store, NOW + 1000)
    expect(r.failed).toBe(false)
    expect(r.route).toBe('/projects/hub')
    expect(r.ui).toEqual({ scrollY: 420 })
    expect(restoredDraft('project:hub:summary')).toBe('новый текст')
    expect(restoredDraft('new-project:title')).toBe('Идея')
    expect(store.data.has(HANDOFF_KEY)).toBe(false)
    expect(getRescue()).toBeNull()
  })

  it('без записи — ничего не восстанавливает', async () => {
    expect(await restoreHandoff(memoryStore(), NOW)).toEqual({ drafts: [], failed: false })
  })

  it('старше суток: экран не восстанавливается, черновики остаются', async () => {
    const store = memoryStore()
    setDraft('k', 'Поле', 'текст')
    await save(store)
    resetDrafts()
    const r = await restoreHandoff(store, NOW + SCREEN_TTL_MS + 1)
    expect(r.route).toBeUndefined()
    expect(r.ui).toBeUndefined()
    expect(restoredDraft('k')).toBe('текст')
  })

  it('запись «из будущего» по времени (сбитые часы) — экран не трогаем', async () => {
    const store = memoryStore()
    await save(store, '#/ideas', 0, NOW + 60_000)
    expect((await restoreHandoff(store, NOW)).route).toBeUndefined()
  })

  it('черновик, не подхваченный экраном, едет и через следующее обновление', async () => {
    const store = memoryStore()
    setDraft('a', 'A', 'старое')
    await save(store)
    resetDrafts()
    await restoreHandoff(store, NOW)
    setDraft('b', 'B', 'новое')
    const h = buildHandoff({ route: '#/', scrollY: 0, now: NOW, build: 'x' })
    expect(h.drafts.map((d) => [d.key, d.text])).toEqual([
      ['a', 'старое'],
      ['b', 'новое'],
    ])
  })

  it('живой черновик заменяет пришедший; discard убирает пришедший', async () => {
    const store = memoryStore()
    setDraft('a', 'A', 'старое')
    setDraft('b', 'B', 'второе')
    await save(store)
    resetDrafts()
    await restoreHandoff(store, NOW)
    setDraft('a', 'A', 'правлю дальше')
    expect(restoredDraft('a')).toBeUndefined()
    discardRestoredDraft('b')
    clearDraft('a')
    expect(buildHandoff({ route: '#/', scrollY: 0, now: NOW, build: 'x' }).drafts).toEqual([])
  })

  it('недопустимый адрес в записи не применяется, черновики — да', async () => {
    const store = memoryStore()
    setDraft('k', 'Поле', 'т')
    await save(store, 'https://evil.example/#/x')
    resetDrafts()
    const r = await restoreHandoff(store, NOW)
    expect(r.route).toBeUndefined()
    expect(restoredDraft('k')).toBe('т')
  })
})

describe('перенос не удался (ADR-011 §6)', () => {
  it('версия выше известной (откат деплоя): запись в handoff-failed, текст для копирования', async () => {
    const raw = { stateVersion: STATE_VERSION + 1, drafts: [{ key: 'k', label: 'Хаб · описание', text: 'важный текст' }], somethingNew: 1 }
    const store = memoryStore({ [HANDOFF_KEY]: raw })
    const r = await restoreHandoff(store, NOW)
    expect(r).toEqual({ drafts: [], failed: true })
    expect(store.data.get(FAILED_KEY)).toEqual(raw)
    expect(store.data.has(HANDOFF_KEY)).toBe(false)
    expect(getRescue()).toBe('Хаб · описание\nважный текст')
    expect(restoredDraft('k')).toBeUndefined()
  })

  it('битая запись текущей версии — тоже в handoff-failed, ничего не выброшено', async () => {
    const raw = { stateVersion: STATE_VERSION, at: NOW, build: 'x', route: '#/', drafts: [{ key: 'k', text: 5 }], ui: {} }
    const store = memoryStore({ [HANDOFF_KEY]: raw })
    expect((await restoreHandoff(store, NOW)).failed).toBe(true)
    expect(store.data.get(FAILED_KEY)).toEqual(raw)
    expect(getRescue()).toContain('"stateVersion"')
  })

  it('без версии вообще — не восстанавливается', async () => {
    const store = memoryStore({ [HANDOFF_KEY]: 'мусор' })
    expect((await restoreHandoff(store, NOW)).failed).toBe(true)
    expect(getRescue()).toBe('"мусор"')
  })

  it('прошлая неудача показывается снова при запуске и не затирается новой', async () => {
    const first = { stateVersion: 99, drafts: [{ label: 'Первое', text: 'раз' }] }
    const store = memoryStore({ [FAILED_KEY]: first, [HANDOFF_KEY]: { stateVersion: 99, drafts: [{ label: 'Второе', text: 'два' }] } })
    await restoreHandoff(store, NOW)
    expect(getRescue()).toBe('Первое\nраз\n\nВторое\nдва')

    resetDrafts()
    await restoreHandoff(store, NOW)
    expect(getRescue()).toBe('Первое\nраз\n\nВторое\nдва')

    await dismissRescue(store)
    expect(getRescue()).toBeNull()
    expect(store.data.has(FAILED_KEY)).toBe(false)
  })
})

describe('разбор и защита', () => {
  it('parseHandoff отбрасывает лишнее и чинит прокрутку', () => {
    const h = parseHandoff({ stateVersion: 1, at: 1, build: 'b', route: '#/', drafts: [{ key: 'k', label: 'l', text: 't', extra: 1 }], ui: { scrollY: -5 } })
    expect(h).toEqual({ stateVersion: STATE_VERSION, at: 1, build: 'b', route: '#/', drafts: [{ key: 'k', label: 'l', text: 't' }], ui: { scrollY: 0 } })
    expect(() => parseHandoff({ at: 1, build: 'b', route: '#/', drafts: 'x' })).toThrow()
  })

  it.each([
    ['#/projects/hub', '/projects/hub'],
    ['#/', '/'],
    ['#//evil.example', undefined],
    ['/projects', undefined],
    ['javascript:alert(1)', undefined],
    ['#/a\nb', undefined],
    ['#/a\\b', undefined],
    ['#/' + 'x'.repeat(3000), undefined],
  ])('safeRoute(%j) → %j', (route, expected) => expect(safeRoute(route)).toBe(expected))

  it('rescueText: незнакомый формат черновиков тоже читается', () => {
    expect(rescueText({ drafts: [{ key: 'k', value: 'v' }, { text: '' }, null] })).toBe('k\nv')
    expect(rescueText({ other: 1 })).toBe('{\n  "other": 1\n}')
  })
})

describe('useDraft', () => {
  function Field({ k }: { k: string }) {
    const { restored } = useDraft(k, undefined, 'Поле')
    return <span>{restored ?? '—'}</span>
  }

  it('отдаёт текст, пришедший от прошлой версии', async () => {
    const store = memoryStore()
    setDraft('k', 'Поле', 'из прошлой версии')
    await save(store)
    resetDrafts()
    await restoreHandoff(store, NOW)
    expect(renderToStaticMarkup(<Field k="k" />)).toBe('<span>из прошлой версии</span>')
    expect(renderToStaticMarkup(<Field k="other" />)).toBe('<span>—</span>')
  })

  it('ключ null — поле черновики не отдаёт и не забирает', async () => {
    const store = memoryStore()
    setDraft('k', 'Поле', 'из прошлой версии')
    await save(store)
    resetDrafts()
    await restoreHandoff(store, NOW)
    function Off() {
      const { restored } = useDraft(null, 'текст', 'Поле')
      return <span>{restored ?? '—'}</span>
    }
    expect(renderToStaticMarkup(<Off />)).toBe('<span>—</span>')
    expect(restoredDraft('k')).toBe('из прошлой версии')
  })

  it('useDraftText: всегда открытое поле стартует с черновика прошлой версии', async () => {
    const store = memoryStore()
    setDraft('project:hub:log', 'Запись в лог', 'полдела')
    await save(store)
    resetDrafts()
    await restoreHandoff(store, NOW)
    function Log({ k }: { k: string }) {
      const [text] = useDraftText(k, 'Запись в лог')
      return <textarea value={text} readOnly />
    }
    expect(renderToStaticMarkup(<Log k="project:hub:log" />)).toContain('полдела')
    expect(renderToStaticMarkup(<Log k="project:other:log" />)).toBe('<textarea readOnly=""></textarea>')
  })
})

describe('IndexedDB', () => {
  it('idbStateStore пишет и читает; wipeDrafts стирает базу', async () => {
    const store = idbStateStore()
    setDraft('k', 'Поле', 'т')
    await save(store)
    expect((await store.get(HANDOFF_KEY)) as object).toMatchObject({ stateVersion: STATE_VERSION, drafts: [{ key: 'k' }] })
    await wipeDrafts()
    expect(await idbStateStore().get(HANDOFF_KEY)).toBeUndefined()
  })
})
