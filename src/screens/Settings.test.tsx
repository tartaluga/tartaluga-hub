import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { useSession } from '../app/session'
import { Shell } from '../app/Shell'
import { Settings } from './Settings'
import { Security } from './Security'
import { Branches } from './Branches'

const settingsFile = (over: object = {}) => ({
  path: 'settings.json',
  sha: 's1',
  text: JSON.stringify({ schemaVersion: 1, abandonedAfterDays: 21, tags: [{ id: 'web', name: 'веб', color: '#9184d9' }, { id: 'hw', name: 'железо', color: '#8a8fa6' }], ...over }),
})

const render = (el: React.ReactElement, path = '/settings') => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>)

/**
 * Серверный рендер читает у zustand начальное состояние (getServerSnapshot), а не текущее.
 * Объект начального состояния у zustand один и тот же, поэтому переписываем его текущим.
 */
function setState(partial: Partial<ReturnType<typeof useSession.getState>>) {
  useSession.setState(partial)
  Object.assign(useSession.getInitialState(), useSession.getState())
}

beforeEach(() => {
  setState({ phase: 'ready', branch: 'main', files: [settingsFile()], sync: 'idle', me: null })
})

describe('экран «Настройки»', () => {
  it('теги по порядку файла, порог, разделы безопасности и данных', () => {
    const html = render(<Settings />)
    expect(html.indexOf('веб')).toBeLessThan(html.indexOf('железо'))
    expect(html).toContain('value="21"')
    expect(html).toContain('дней без записей в логе и коммитов')
    expect(html).toContain('href="/settings/security"')
    expect(html).toContain('href="/settings/branches"')
    expect(html).toContain('Новый тег')
    expect(html).toContain('role="radiogroup" aria-label="Тема"')
  })

  it('нет settings.json — пустой список, править можно (файл создастся), порог по умолчанию', () => {
    setState({ files: [] })
    const html = render(<Settings />)
    expect(html).toContain('Тегов пока нет')
    expect(html).toContain('Новый тег')
    expect(html).toContain('value="14"')
  })

  it('файл новой версии формата — только чтение с причиной', () => {
    setState({ files: [settingsFile({ schemaVersion: 2 })] })
    const html = render(<Settings />)
    expect(html).toContain('role="alert"')
    expect(html).toMatch(/v2/)
    expect(html).not.toContain('Новый тег')
    expect(html).not.toContain('Удалить тег')
  })

  it('разделы внутри настроек — с крошками «Настройки · …»', () => {
    expect(render(<Security />, '/settings/security')).toMatch(/<a href="\/settings"[^>]*>Настройки<\/a> · Безопасность/)
    expect(render(<Branches />, '/settings/branches')).toMatch(/<a href="\/settings"[^>]*>Настройки<\/a> · Данные/)
  })
})

describe('навигация', () => {
  const gear = (html: string) => (html.match(/aria-label="Настройки"/g) ?? []).length
  it('шестерёнка в шапке телефона — на «Сегодня» и «Проекты», не на других экранах', () => {
    expect(gear(render(<Shell />, '/'))).toBe(1)
    expect(gear(render(<Shell />, '/projects'))).toBe(1)
    expect(gear(render(<Shell />, '/ideas'))).toBe(0)
    expect(gear(render(<Shell />, '/settings'))).toBe(0)
  })

  it('в боковой панели — пункт «Настройки», без отдельных ссылок на ветки и ключи', () => {
    const html = render(<Shell />, '/')
    expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*>.*?<span>Настройки<\/span>/)
    expect(html).not.toContain('href="/security"')
    expect(html).not.toContain('href="/branches"')
    expect(html).toContain('aria-label="Тема"')
  })
})
