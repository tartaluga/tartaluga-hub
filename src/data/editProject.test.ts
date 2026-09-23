import { describe, expect, it } from 'vitest'
import { applyEdit, linkHref, linkText, newLink, normalizePatch, patchError, rebaseEdit, vscodeHref, webUrl } from './editProject'
import { parseFile, serialize } from './model'

const NOW = new Date(2026, 8, 23, 15, 0, 0)
const base = {
  schemaVersion: 1,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  nextStep: 'Починить парсер',
  futureField: { keep: true },
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}

describe('normalizePatch и patchError', () => {
  it('пробелы схлопываются, пустое становится null, повторы убираются', () => {
    expect(
      normalizePatch({ title: '  Бот   2 ', nextStep: '   ', description: '\r\n Текст\r\n\r\nещё \n', stack: [' React ', '', 'React', 'TS'], tags: ['a', 'a'], links: [] }),
    ).toEqual({ title: 'Бот 2', nextStep: null, description: 'Текст\n\nещё', stack: ['React', 'TS'], tags: ['a'], links: null })
    expect(normalizePatch({ stack: ['  '] })).toEqual({ stack: null })
    expect(normalizePatch({ description: null, nextStep: null })).toEqual({ description: null, nextStep: null })
  })

  it('пустое название и слишком длинные поля не проходят', () => {
    expect(patchError(normalizePatch({ title: '  ' }))).toBe('Нужно название')
    expect(patchError({ title: 'x'.repeat(121) })).toMatch(/Название/)
    expect(patchError({ title: 'x'.repeat(120) })).toBeNull()
    expect(patchError({ nextStep: 'x'.repeat(201) })).toMatch(/шаг/)
    expect(patchError({ description: 'x'.repeat(20_001) })).toMatch(/Описание/)
    expect(patchError({ stack: ['x'.repeat(41)] })).toMatch(/стека/)
    expect(patchError({ nextStep: null, description: null })).toBeNull()
  })
})

describe('applyEdit', () => {
  it('меняет только поля правки, незнакомые поля и порядок ключей сохраняет, updatedAt — сейчас', () => {
    const out = applyEdit(base, { title: 'Бот 2', stack: ['TS'] }, NOW)
    expect(Object.keys(out)).toEqual(['schemaVersion', 'slug', 'title', 'status', 'nextStep', 'futureField', 'stack', 'createdAt', 'updatedAt'])
    expect(out).toMatchObject({ title: 'Бот 2', stack: ['TS'], futureField: { keep: true }, createdAt: base.createdAt })
    expect(out.updatedAt).not.toBe(base.updatedAt)
    expect(out.updatedAt.startsWith('2026-09-23T15:00:00')).toBe(true)
    expect(base.title).toBe('Бот') // исходный объект не трогается
  })

  it('null убирает поле; результат проходит схему', () => {
    const out = applyEdit(base, { nextStep: null, description: null }, NOW)
    expect(out).not.toHaveProperty('nextStep')
    expect(out).not.toHaveProperty('description')
    expect(parseFile('projects/bot.json', '', serialize(out))).toMatchObject({ ok: true, readOnly: false })
  })
})

describe('rebaseEdit', () => {
  const edited = { ...base, updatedAt: 'x' }

  it('в другом месте поменяли другое поле — правка накладывается', () => {
    expect(rebaseEdit(base, { ...edited, nextStep: 'Другое' }, { title: 'Бот 2' })).toEqual({ kind: 'apply' })
  })

  it('то же поле поменяли по-другому — конфликт с именем поля', () => {
    expect(rebaseEdit(base, { ...edited, title: 'Бот 3' }, { title: 'Бот 2', status: 'done' })).toEqual({ kind: 'conflict', fields: ['title'] })
  })

  it('там уже ровно наша правка — писать нечего', () => {
    expect(rebaseEdit(base, { ...edited, title: 'Бот 2' }, { title: 'Бот 2' })).toEqual({ kind: 'already' })
    expect(rebaseEdit(base, { ...edited, nextStep: undefined }, { nextStep: null })).toEqual({ kind: 'already' })
  })

  it('часть полей уже совпадает, остальные не тронуты — накладывается', () => {
    expect(rebaseEdit(base, { ...edited, title: 'Бот 2' }, { title: 'Бот 2', status: 'done' })).toEqual({ kind: 'apply' })
  })

  it('списки сравниваются по содержимому', () => {
    const b = { ...base, stack: ['A', 'B'] }
    expect(rebaseEdit(b, { ...b, stack: ['A', 'B'] }, { stack: ['A'] })).toEqual({ kind: 'apply' })
    expect(rebaseEdit(b, { ...b, stack: ['B', 'A'] }, { stack: ['A'] })).toEqual({ kind: 'conflict', fields: ['stack'] })
  })
})

describe('ссылки', () => {
  it('href только https/http и vscode://file/ из пути папки', () => {
    expect(linkHref({ kind: 'site', value: 'https://example.com/a' })).toBe('https://example.com/a')
    expect(linkHref({ kind: 'local', value: 'http://localhost:5173' })).toBe('http://localhost:5173/')
    for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', 'vscode://ms-vscode/cmd', 'file:///C:/x', '//evil.com', 'example.com']) {
      expect(linkHref({ kind: 'site', value })).toBeNull()
      expect(linkHref({ kind: 'unknown-kind', value })).toBeNull()
    }
    expect(linkHref({ kind: 'repo', value: 'tartaluga/tartaluga-hub' })).toBe('https://github.com/tartaluga/tartaluga-hub')
    expect(linkHref({ kind: 'repo', value: 'javascript:alert(1)//x' })).toBeNull()
    expect(linkHref({ kind: 'folder', value: 'javascript:alert(1)' })).toBeNull()
    expect(webUrl('  https://x.dev  ')).toBe('https://x.dev/')
  })

  it('vscode://file/ из пути: слеши, пробелы и решётка кодируются, диск остаётся', () => {
    expect(vscodeHref('C:\\Users\\me\\My Projects\\bot#1')).toBe('vscode://file/C:/Users/me/My%20Projects/bot%231')
    expect(vscodeHref('/home/me/bot')).toBe('vscode://file/home/me/bot')
    expect(vscodeHref('projects\\bot')).toBeNull()
    expect(vscodeHref('C:\\a\nb')).toBeNull()
  })

  it('подпись: своя или значение без протокола', () => {
    expect(linkText({ kind: 'site', value: 'https://bot.dev/', label: '' })).toBe('bot.dev')
    expect(linkText({ kind: 'site', value: 'https://bot.dev', label: ' Прод ' })).toBe('Прод')
    expect(linkText({ kind: 'folder', value: 'C:\\bot' })).toBe('C:\\bot')
  })

  it('newLink проверяет значение по виду и даёт ULID', () => {
    const repo = newLink('repo', ' https://github.com/tartaluga/hub.git ', '')
    expect(repo).toMatchObject({ ok: true, link: { kind: 'repo', value: 'tartaluga/hub' } })
    if (repo.ok) {
      expect(repo.link.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(repo.link).not.toHaveProperty('label')
    }
    expect(newLink('site', 'https://bot.dev', ' Прод ')).toMatchObject({ ok: true, link: { value: 'https://bot.dev', label: 'Прод' } })
    expect(newLink('site', 'HTTPS://bot.dev', '')).toMatchObject({ ok: false })
    expect(newLink('doc', 'javascript:alert(1)', '')).toMatchObject({ ok: false })
    expect(newLink('folder', 'bot', '')).toMatchObject({ ok: false })
    expect(newLink('folder', 'C:\\bot', '')).toMatchObject({ ok: true })
    expect(newLink('repo', 'bot', '')).toMatchObject({ ok: false })
    expect(newLink('site', '   ', '')).toMatchObject({ ok: false })
    expect(newLink('site', 'https://a.b', 'x'.repeat(81))).toMatchObject({ ok: false })
  })

  it('ссылка из newLink проходит схему файла', () => {
    const links = (['folder', 'repo', 'site', 'local', 'doc', 'other'] as const).map((k) => {
      const r = newLink(k, k === 'folder' ? 'C:\\bot' : k === 'repo' ? 'a/b' : 'https://a.b', 'x')
      if (!r.ok) throw new Error(r.error)
      return r.link
    })
    expect(parseFile('projects/bot.json', '', serialize(applyEdit(base, { links }, NOW)))).toMatchObject({ ok: true, readOnly: false })
  })
})
