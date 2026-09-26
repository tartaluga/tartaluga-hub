// Экран «Входящие конфликты» и индикатор синхронизации (ADR-004, ADR-010 §2): серверный рендер.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { useSession } from '../app/session'
import { Shell } from '../app/Shell'
import { Conflicts, conflictCount } from './Conflicts'
import { SyncIndicator, conflictText, syncText } from '../components/SyncIndicator'
import type { StoredConflict } from '../lib/localdb'

const render = (el: React.ReactElement, path = '/conflicts') => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>)

/** Серверный рендер читает начальное состояние zustand — переписываем его текущим (как в Settings.test). */
function setState(partial: Partial<ReturnType<typeof useSession.getState>>) {
  useSession.setState(partial)
  Object.assign(useSession.getInitialState(), useSession.getState())
}

const rec = (over: Partial<StoredConflict> = {}): StoredConflict => ({
  branch: 'main',
  path: 'projects/a.json',
  title: 'Диплом',
  at: '2026-09-26T10:00:00+03:00',
  items: [{ kind: 'field', path: ['nextStep'], base: 'а', local: 'моё значение', remote: 'значение из репо' }],
  labels: ['следующий шаг'],
  ...over,
})

beforeEach(() => {
  setState({ phase: 'ready', branch: 'main', files: [], sync: 'idle', syncError: null, lastSync: null, me: null, queued: 0, conflicts: [] })
})

describe('экран «Входящие конфликты»', () => {
  it('пусто — «конфликтов нет», без кнопок «все»', () => {
    const html = render(<Conflicts />)
    expect(html).toContain('конфликтов нет')
    expect(html).toContain('Всё записано')
    expect(html).not.toContain('Все мои')
  })

  it('спорное поле: проект, подпись, обе версии и выбор', () => {
    setState({ conflicts: [rec()] })
    const html = render(<Conflicts />)
    expect(html).toContain('1 конфликт')
    expect(html).toContain('Диплом')
    expect(html).toContain('поле · следующий шаг')
    expect(html).toContain('моё значение')
    expect(html).toContain('значение из репо')
    expect(html).toContain('Оставить мою')
    expect(html).toContain('Взять из репо')
    expect(html).toContain('Все мои')
    expect(html).not.toContain('Выбрать по кускам')
    expect(html).not.toContain('ветка ')
  })

  it('длинный текст — кнопка выбора по кускам; не main — ветка в подписи', () => {
    const long = rec({ branch: 'feat', items: [{ kind: 'field', path: ['description'], base: 'а\nб', local: 'а\nв', remote: 'г\nб' }], labels: ['описание'] })
    setState({ conflicts: [long] })
    const after = render(<Conflicts />)
    expect(after).toContain('Выбрать по кускам')
    expect(after).toContain('ветка feat')
  })

  it('отказ сервера и удаление в репо — отдельные карточки', () => {
    setState({
      conflicts: [
        rec({ path: 'projects/b.json', title: 'Б', items: [], labels: [], refused: { reason: 'Файл не прошёл схему', mine: '{"x":1}' } }),
        rec({ path: 'projects/c.json', title: 'В', items: [], labels: [], deleted: { mine: '{}' } }),
      ],
    })
    const html = render(<Conflicts />)
    expect(html).toContain('2 конфликта')
    expect(html).toContain('правка не записана')
    expect(html).toContain('Файл не прошёл схему')
    expect(html).toContain('проект удалён в репо')
    expect(html).toContain('Вернуть проект')
    expect(html).toContain('Согласиться с удалением')
  })

  it('данные из репо — только текст', () => {
    setState({ conflicts: [rec({ title: '<script>x</script>', items: [{ kind: 'field', path: ['nextStep'], base: '', local: 'а', remote: '<img src=x onerror=alert(1)>' }] })] })
    const html = render(<Conflicts />)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x')
  })

  it('ожидающие правки видны на экране', () => {
    setState({ conflicts: [rec()], queued: 2 })
    expect(render(<Conflicts />)).toContain('2 правки ждут отправки')
  })

  it('счёт: запись без мест — одно место', () => {
    expect(conflictCount([rec(), rec({ items: [], refused: { reason: 'r', mine: '' } })])).toBe(2)
  })
})

describe('индикатор синхронизации', () => {
  const now = Date.parse('2026-09-26T10:05:00Z')
  const at = new Date('2026-09-26T10:03:00Z')

  it('всё сохранено / в очереди / нет сети / ошибка / вход', () => {
    expect(syncText('idle', 0, at, now)).toBe('сохранено · 2 мин назад')
    expect(syncText('idle', 0, null, now)).toBe('SYNC · ещё не было')
    expect(syncText('idle', 3, at, now)).toBe('3 правки ждут отправки')
    expect(syncText('idle', 1, at, now)).toBe('1 правка ждёт отправки')
    expect(syncText('offline', 5, at, now)).toBe('OFFLINE · 5 правок на устройстве')
    expect(syncText('offline', 0, at, now)).toBe('OFFLINE · данные из кэша')
    expect(syncText('error', 0, at, now)).toBe('SYNC · ошибка')
    expect(syncText('error', 2, at, now)).toBe('ошибка · 2 правки в очереди')
    expect(syncText('sessionExpired', 2, at, now)).toBe('НУЖЕН ВХОД · сессия истекла')
  })

  it('конфликты — ссылка на «Входящие»', () => {
    expect(conflictText(0)).toBeNull()
    expect(conflictText(2)).toBe('2 конфликта · разобрать')
    expect(render(<SyncIndicator />, '/')).not.toContain('href="/conflicts"')
    setState({ conflicts: [rec()] })
    const html = render(<SyncIndicator />, '/')
    expect(html).toContain('href="/conflicts"')
    expect(html).toContain('1 конфликт · разобрать')
  })

  it('очередь — своё состояние индикатора', () => {
    setState({ queued: 1 })
    expect(render(<SyncIndicator />, '/')).toContain('data-state="queued"')
    setState({ queued: 1, sync: 'error' })
    expect(render(<SyncIndicator />, '/')).toContain('data-state="error"')
  })
})

describe('раздел в навигации', () => {
  it('пункт «Конфликты» — только когда есть что разбирать', () => {
    expect(render(<Shell />, '/')).not.toContain('Конфликты')
    setState({ conflicts: [rec()] })
    expect(render(<Shell />, '/')).toContain('Конфликты')
  })
})
