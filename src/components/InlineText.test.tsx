import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreHandoff, resetDrafts, saveHandoff, setDraft, type StateStore } from '../lib/drafts'
import { InlineText } from './InlineText'
import { hasNewProjectDraft } from '../data/newProject'

function memoryStore(): StateStore {
  const data = new Map<string, unknown>()
  return {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
  }
}

/** Прошлая версия оставила черновики; новая их подхватила. */
async function carry(drafts: Record<string, string>) {
  const store = memoryStore()
  for (const [k, v] of Object.entries(drafts)) setDraft(k, k, v)
  await saveHandoff(store, { route: '#/projects/hub', scrollY: 0, now: 1, build: 'old' })
  resetDrafts()
  await restoreHandoff(store, 1)
}

const field = (props: { draftKey?: string; readOnly?: boolean }) =>
  renderToStaticMarkup(<InlineText value="сохранено" placeholder="—" label="Название" maxLength={100} onSave={async () => null} {...props} />)

afterEach(() => resetDrafts())

describe('InlineText: черновик переживает обновление хаба (ADR-011)', () => {
  it('без черновика — просто значение', () => {
    expect(field({ draftKey: 'project:hub:title' })).not.toContain('<input')
  })

  it('черновик от прошлой версии — поле сразу открыто с ним', async () => {
    await carry({ 'project:hub:title': 'недописанное' })
    const html = field({ draftKey: 'project:hub:title' })
    expect(html).toContain('<input')
    expect(html).toContain('value="недописанное"')
  })

  it('чужой ключ и поле без ключа черновик не забирают', async () => {
    await carry({ 'project:hub:title': 'недописанное' })
    expect(field({ draftKey: 'project:other:title' })).not.toContain('недописанное')
    expect(field({})).not.toContain('недописанное')
  })

  it('только чтение — поле не открывается', async () => {
    await carry({ 'project:hub:title': 'недописанное' })
    expect(field({ draftKey: 'project:hub:title', readOnly: true })).not.toContain('<input')
  })
})

describe('Новый проект: незаконченная форма', () => {
  it('окно открывается, если пришло название или следующий шаг', async () => {
    expect(hasNewProjectDraft()).toBe(false)
    await carry({ 'new-project:nextStep': 'шаг' })
    expect(hasNewProjectDraft()).toBe(true)
  })
})
