import { describe, expect, it } from 'vitest'
import { applyEdit, linkHref, linkText, logKindLabel, logWhen, mergePatch, newLink, newLogEntry, normalizePatch, patchError, rebaseEdit, sortedLog, vscodeHref, webUrl } from './editProject'
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

describe('лог', () => {
  const e = (id: string, at: string, text = 'x', kind = 'done') => ({ id: id.padEnd(26, 'A'), at, kind, text })
  const withLog = { ...base, log: [e('01J1', '2026-09-20T10:00:00+03:00')] }

  it('новая запись — в конец лога, повтор с тем же id не дублирует, удаление по id', () => {
    const added = applyEdit(withLog, normalizePatch({ logAdd: [e('01J2', '2026-09-23T10:00:00+03:00', '  текст \r\n')] }), NOW)
    expect(added.log.map((x) => [x.id.slice(0, 4), x.text])).toEqual([
      ['01J1', 'x'],
      ['01J2', 'текст'],
    ])
    const again = applyEdit(added, { logAdd: [e('01J2', '2026-09-23T10:00:00+03:00', 'текст')] }, NOW)
    expect(again.log).toHaveLength(2)
    const removed = applyEdit(again, { logRemove: [e('01J1', '').id] }, NOW)
    expect(removed.log.map((x) => x.id.slice(0, 4))).toEqual(['01J2'])
    expect(applyEdit(removed, { logRemove: [e('01J2', '').id] }, NOW)).not.toHaveProperty('log')
    expect(parseFile('projects/bot.json', '', serialize(again))).toMatchObject({ ok: true, readOnly: false })
  })

  it('пустая и слишком длинная запись не проходят', () => {
    expect(patchError(normalizePatch({ logAdd: [e('01J2', '2026-09-23T10:00:00+03:00', '   ')] }))).toMatch(/Пустую/)
    expect(patchError({ logAdd: [e('01J2', '2026-09-23T10:00:00+03:00', 'x'.repeat(2001))] })).toMatch(/длиннее/)
  })

  it('записи лога не конфликтуют с чужими правками; уже добавленная — «already»', () => {
    const theirs = { ...withLog, log: [...withLog.log, e('01J9', '2026-09-23T09:00:00+03:00')], title: 'Чужое' }
    expect(rebaseEdit(withLog, theirs, { logAdd: [e('01J2', '2026-09-23T10:00:00+03:00')] })).toEqual({ kind: 'apply' })
    const both = { ...theirs, log: [...theirs.log, e('01J2', '2026-09-23T10:00:00+03:00')] }
    expect(rebaseEdit(withLog, both, { logAdd: [e('01J2', '2026-09-23T10:00:00+03:00')] })).toEqual({ kind: 'already' })
    expect(rebaseEdit(withLog, { ...withLog, log: [] }, { logRemove: [e('01J1', '').id] })).toEqual({ kind: 'already' })
    // Поле рядом с записью лога по-прежнему проверяется на конфликт.
    expect(rebaseEdit(withLog, theirs, { title: 'Моё', logAdd: [e('01J2', '2026-09-23T10:00:00+03:00')] })).toEqual({ kind: 'conflict', fields: ['title'] })
  })

  it('mergePatch копит записи, а добавленная и сразу убранная до отправки не попадает в файл', () => {
    const a = { logAdd: [e('01J2', 't')], title: 'А' }
    const b = { logAdd: [e('01J3', 't')], title: 'Б' }
    expect(mergePatch(a, b)).toEqual({ title: 'Б', logAdd: [e('01J2', 't'), e('01J3', 't')] })
    expect(mergePatch(a, { logRemove: [e('01J2', '').id, e('01J1', '').id] })).toEqual({ title: 'А', logRemove: [e('01J1', '').id] })
  })

  it('лента: свежие сверху по времени, а не по порядку в файле; битая дата внизу', () => {
    const log = [e('01J1', '2026-09-20T10:00:00+03:00'), e('01J2', 'нет даты'), e('01J3', '2026-09-23T10:00:00+03:00'), e('01J4', '2026-09-21T10:00:00Z')]
    expect(sortedLog(log).map((x) => x.id.slice(0, 4))).toEqual(['01J3', '01J4', '01J1', '01J2'])
  })

  it('подписи: вид записи и местное время', () => {
    expect([logKindLabel('done'), logKindLabel('decision'), logKindLabel('thought'), logKindLabel('idea-new')]).toEqual(['сделано', 'решение', 'мысль', 'запись'])
    const now = new Date(2026, 8, 23, 15, 0)
    const local = (d: number, h: number, m: number, y = 2026, mo = 8) => new Date(y, mo, d, h, m).toISOString()
    expect(logWhen(local(23, 9, 5), now)).toBe('сегодня · 09:05')
    expect(logWhen(local(22, 23, 59), now)).toBe('вчера · 23:59')
    expect(logWhen(local(1, 0, 0), now)).toBe('01.09 · 00:00')
    expect(logWhen(local(31, 12, 0, 2025, 11), now)).toBe('31.12.2025')
    expect(logWhen('мусор', now)).toBe('мусор')
  })

  it('newLogEntry: ULID, момент со смещением, текст без пробелов по краям — проходит схему', () => {
    const entry = newLogEntry('decision', '  Берём Визор \r\n', NOW)
    expect(entry).toMatchObject({ kind: 'decision', text: 'Берём Визор' })
    expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(parseFile('projects/bot.json', '', serialize(applyEdit(base, { logAdd: [entry] }, NOW)))).toMatchObject({ ok: true, readOnly: false })
  })
})
