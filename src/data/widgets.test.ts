import { describe, expect, it } from 'vitest'
import type { Status } from '../schema/types'
import {
  ago,
  commitTitle,
  deployTarget,
  deployView,
  lastCommits,
  parseStatus,
  projectErrors,
  projectStatus,
  runView,
  shortSha,
  siteView,
  staleHours,
  statusHref,
  tokenErrors,
} from './widgets'

const examples = import.meta.glob<string>('../../schema/examples/valid/status*.json', { eager: true, query: '?raw', import: 'default' })
const example = (name: string) => examples[`../../schema/examples/valid/${name}`]!
const H = 60 * 60 * 1000

function status(extra: Partial<Status> = {}): Status {
  return { schemaVersion: 1, generatedAt: '2026-09-29T10:00:00Z', lastSuccess: null, errors: [], projects: {}, ...extra }
}

describe('parseStatus', () => {
  it('примеры схемы проходят', () => {
    expect(parseStatus(example('status.json')).ok).toBe(true)
    expect(parseStatus(example('status-empty.json')).ok).toBe(true)
  })

  it('не JSON и не по схеме — ошибка с причиной, а не данные', () => {
    expect(parseStatus('{')).toEqual({ ok: false, error: 'status.json — не JSON' })
    const bad = parseStatus(JSON.stringify({ ...status(), projects: { a: { site: { url: 'https://x', state: 'maybe', checkedAt: '2026-09-29T10:00:00Z' } } } }))
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/^status\.json не прошёл проверку: .*state/)
    // Больше 5 коммитов — схема не пускает (ограничение на размер того, что рисуем).
    const commits = Array.from({ length: 6 }, (_, i) => ({ sha: `a${i}`, message: 'm', date: '2026-09-29T10:00:00Z' }))
    expect(parseStatus(JSON.stringify({ ...status(), projects: { a: { repo: { fullName: 'o/r', commits } } } })).ok).toBe(false)
  })
})

describe('данные проекта', () => {
  it('projectStatus — только собственные ключи', () => {
    const s = status({ projects: { a: { repo: { fullName: 'o/a' } } } })
    expect(projectStatus(s, 'a')).toEqual({ repo: { fullName: 'o/a' } })
    expect(projectStatus(s, '__proto__')).toBeNull()
    expect(projectStatus(s, 'constructor')).toBeNull()
    expect(projectStatus(null, 'a')).toBeNull()
  })

  it('lastCommits — самый свежий коммит каждого репо, битые даты пропускаются', () => {
    const s = status({
      projects: {
        a: { repo: { fullName: 'o/a', commits: [{ sha: '1', message: 'm', date: '2026-09-28T10:00:00Z' }, { sha: '2', message: 'm', date: '2026-09-29T10:00:00Z' }] } },
        b: { repo: { fullName: 'o/b', commits: [] } },
        c: { site: { url: 'https://c', state: 'up', checkedAt: '2026-09-29T10:00:00Z' } },
      },
    })
    expect([...lastCommits(s)]).toEqual([['a', Date.parse('2026-09-29T10:00:00Z')]])
    expect(lastCommits(null).size).toBe(0)
  })

  it('ошибки: токен — общие, repo_not_accessible — у своего проекта', () => {
    const s = status({
      errors: [
        { code: 'token_expired', message: 'x' },
        { code: 'repo_not_accessible', message: 'y', project: 'a', repo: 'me/a' },
        { code: 'other', message: 'z', project: 'b' },
      ],
    })
    expect(tokenErrors(s).map((e) => e.code)).toEqual(['token_expired'])
    expect(projectErrors(s, 'a').map((e) => e.code)).toEqual(['repo_not_accessible'])
    expect(projectErrors(s, 'c')).toEqual([])
  })
})

describe('подписи', () => {
  const now = Date.parse('2026-09-29T20:00:00Z')

  it('виджеты не обновлялись — с 8 часов', () => {
    expect(staleHours(status({ generatedAt: new Date(now - 8 * H + 60_000).toISOString() }), now)).toBeNull()
    expect(staleHours(status({ generatedAt: new Date(now - 8 * H).toISOString() }), now)).toBe(8)
    expect(staleHours(status({ generatedAt: new Date(now - 30 * H).toISOString() }), now)).toBe(30)
    expect(staleHours(status({ generatedAt: null }), now)).toBeNull()
    expect(staleHours(null, now)).toBeNull()
  })

  it('ago', () => {
    expect(ago(new Date(now - 30_000).toISOString(), now)).toBe('только что')
    expect(ago(new Date(now + H).toISOString(), now)).toBe('только что')
    expect(ago(new Date(now - 12 * 60_000).toISOString(), now)).toBe('12 мин назад')
    expect(ago(new Date(now - 3 * H).toISOString(), now)).toBe('3 ч назад')
    expect(ago(new Date(now - 50 * H).toISOString(), now)).toBe('2 дн назад')
    expect(ago('не дата', now)).toBe('')
  })

  it('сайт: blocked — «не проверить», а не «упал»', () => {
    expect(siteView({ state: 'up' })).toEqual({ tone: 'ok', text: 'работает' })
    expect(siteView({ state: 'down' })).toEqual({ tone: 'bad', text: 'не отвечает' })
    expect(siteView({ state: 'blocked' })).toEqual({ tone: 'muted', text: 'не проверить' })
  })

  it('Actions: идёт, в очереди, итоги', () => {
    expect(runView({ status: 'in_progress', conclusion: null }).text).toBe('идёт')
    expect(runView({ status: 'queued', conclusion: null }).text).toBe('в очереди')
    expect(runView({ status: 'completed', conclusion: 'success' })).toEqual({ tone: 'ok', text: 'успешно' })
    expect(runView({ status: 'completed', conclusion: 'failure' })).toEqual({ tone: 'bad', text: 'упал' })
    expect(runView({ status: 'completed', conclusion: 'cancelled' }).tone).toBe('muted')
  })

  it('деплой: известный бот → провайдер, иначе environment', () => {
    expect(deployTarget({ creator: 'netlify[bot]', environment: 'production' })).toBe('Netlify')
    expect(deployTarget({ creator: 'vercel[bot]', environment: 'Preview' })).toBe('Vercel')
    expect(deployTarget({ creator: 'cloudflare-workers-and-pages[bot]', environment: 'production' })).toBe('Cloudflare')
    expect(deployTarget({ creator: 'someone', environment: 'staging' })).toBe('staging')
    expect(deployTarget({ creator: 'evil-netlify[bot]', environment: 'prod' })).toBe('prod')
    expect(deployView({ state: 'success' }).text).toBe('выложен')
    expect(deployView({ state: 'failure' }).tone).toBe('bad')
  })

  it('коммит: первая строка и короткий sha только из hex', () => {
    expect(commitTitle('Первая\nвторая')).toBe('Первая')
    expect(shortSha('e5b0114abcdef')).toBe('e5b0114')
    expect(shortSha('<img>')).toBe('')
  })

  it('ссылки из status.json — только http(s)', () => {
    expect(statusHref('https://github.com/o/r/commit/1')).toBe('https://github.com/o/r/commit/1')
    expect(statusHref('javascript:alert(1)')).toBeNull()
    expect(statusHref('data:text/html,<b>')).toBeNull()
    expect(statusHref('vscode://file/C:/x')).toBeNull()
    expect(statusHref(null)).toBeNull()
  })
})
