import { describe, expect, it } from 'vitest'
import {
  addTag,
  clampDays,
  dropIndex,
  moveTag,
  newTagId,
  nextColor,
  PALETTE,
  readSettings,
  recolorTag,
  removeTag,
  removeWarning,
  renameTag,
  setAbandonedDays,
  tagNameError,
  type SettingsData,
} from './TagEditor.model'
import { validateSettings } from '../schema/validators.js'

const base = (): SettingsData => ({
  schemaVersion: 1,
  future: 'сохранить',
  tags: [
    { id: 'web', name: 'веб', color: '#9184d9', note: 'чужое поле' } as SettingsData['tags'][number],
    { id: 'hobby', name: 'хобби', color: '#d472b2' },
    { id: 'study', name: 'учёба', color: '#6fc2b4' },
  ],
})
const ids = (s: SettingsData) => s.tags.map((t) => t.id)

describe('палитра', () => {
  it('7 цветов, все проходят схему (#rrggbb) и различны', () => {
    expect(PALETTE).toHaveLength(7)
    expect(new Set(PALETTE.map((p) => p.color)).size).toBe(7)
    for (const { color } of PALETTE) expect(validateSettings({ schemaVersion: 1, tags: [{ id: 'a', name: 'a', color }] })).toBe(true)
  })

  it('nextColor берёт первый незанятый, а когда заняты все — по кругу', () => {
    expect(nextColor(base().tags)).toBe(PALETTE[3]!.color)
    const all = PALETTE.map((p, i) => ({ id: `t${i}`, name: `t${i}`, color: p.color.toUpperCase() }))
    expect(nextColor(all)).toBe(PALETTE[0]!.color)
  })
})

describe('имя и id тега', () => {
  it('пустое, длинное и повтор (без учёта регистра и ё) — ошибка', () => {
    const tags = base().tags
    expect(tagNameError('  ', tags)).toMatch(/пуст/)
    expect(tagNameError('x'.repeat(33), tags)).toMatch(/32/)
    expect(tagNameError(' Учеба ', tags)).toMatch(/уже есть/)
    expect(tagNameError('Учеба', tags, 'study')).toBeNull()
    expect(tagNameError('железо', tags)).toBeNull()
  })

  it('id — транслит, занятый получает суффикс, из одних эмодзи — tag', () => {
    expect(newTagId('Железо', [])).toBe('zhelezo')
    expect(newTagId('веб', ['veb', 'veb-2'])).toBe('veb-3')
    expect(newTagId('🙂', [])).toBe('tag')
    expect(newTagId('🙂', ['tag'])).toBe('tag-2')
    expect(newTagId('project', [])).toBe('project')
  })
})

describe('правки settings', () => {
  it('переименование и цвет меняют только свой тег; id и чужие поля остаются', () => {
    const s = recolorTag('web', '#9dbb7a')(renameTag('web', '  сайты   и  боты ')(base()))
    expect(s.tags[0]).toEqual({ id: 'web', name: 'сайты и боты', color: '#9dbb7a', note: 'чужое поле' })
    expect(s.tags.slice(1)).toEqual(base().tags.slice(1))
    expect(s.future).toBe('сохранить')
  })

  it('переименование в имя, которое уже занято в свежем файле, отклоняется', () => {
    expect(() => renameTag('web', 'Хобби')(base())).toThrow(/уже есть/)
    expect(renameTag('hobby', 'ХОББИ')(base()).tags[1]!.name).toBe('ХОББИ')
  })

  it('удаление', () => {
    expect(ids(removeTag('hobby')(base()))).toEqual(['web', 'study'])
    expect(ids(removeTag('нет')(base()))).toEqual(['web', 'hobby', 'study'])
  })

  it('новый тег — в конец; повторное применение не создаёт второй', () => {
    const add = addTag(' железо ', '#8a8fa6')
    const once = add(base())
    expect(once.tags.at(-1)).toEqual({ id: 'zhelezo', name: 'железо', color: '#8a8fa6' })
    expect(add(once)).toEqual(once)
    expect(once.future).toBe('сохранить')
  })

  it('перенос на место index в списке без тега; неизвестный тег — без изменений', () => {
    expect(ids(moveTag('web', 2)(base()))).toEqual(['hobby', 'study', 'web'])
    expect(ids(moveTag('study', 0)(base()))).toEqual(['study', 'web', 'hobby'])
    expect(ids(moveTag('hobby', 99)(base()))).toEqual(['web', 'study', 'hobby'])
    expect(ids(moveTag('hobby', -3)(base()))).toEqual(['hobby', 'web', 'study'])
    expect(moveTag('нет', 0)(base())).toEqual(base())
  })

  it('порог заброшенности зажат в 1…365 по схеме', () => {
    expect(setAbandonedDays(0)(base()).abandonedAfterDays).toBe(1)
    expect(setAbandonedDays(400)(base()).abandonedAfterDays).toBe(365)
    expect(setAbandonedDays(21.4)(base()).abandonedAfterDays).toBe(21)
    expect(clampDays(14)).toBe(14)
    expect(setAbandonedDays(21)(base()).future).toBe('сохранить')
  })

  it('результат правок проходит схему', () => {
    const s = moveTag('web', 1)(addTag('новый', PALETTE[4]!.color)(setAbandonedDays(30)(base())))
    expect(validateSettings(s)).toBe(true)
  })
})

describe('dropIndex: куда встанет перетаскиваемая строка', () => {
  const mids = [10, 30, 50, 70]
  it('считает строки выше курсора, не считая саму перетаскиваемую', () => {
    expect(dropIndex(mids, 0, 5)).toBe(0)
    expect(dropIndex(mids, 0, 35)).toBe(1)
    expect(dropIndex(mids, 0, 100)).toBe(3)
    expect(dropIndex(mids, 3, 0)).toBe(0)
    expect(dropIndex(mids, 3, 45)).toBe(2)
    expect(dropIndex(mids, 1, 30)).toBe(1)
  })
})

describe('readSettings', () => {
  it('нет файла — пусто и порог по умолчанию, править можно', () => {
    expect(readSettings(undefined)).toEqual({ tags: [], days: 14, problem: null })
  })
  it('файл — теги и порог; битый или новой версии — причина «только чтение»', () => {
    const ok = readSettings({ sha: 's', text: JSON.stringify({ schemaVersion: 1, abandonedAfterDays: 9, tags: [{ id: 'a', name: 'а', color: '#9184d9' }] }) })
    expect(ok).toEqual({ tags: [{ id: 'a', name: 'а', color: '#9184d9' }], days: 9, problem: null })
    expect(readSettings({ sha: 's', text: '{' }).problem).toMatch(/не читается/)
    expect(readSettings({ sha: 's', text: JSON.stringify({ schemaVersion: 2, tags: [] }) }).problem).toMatch(/v2/)
  })
})

describe('removeWarning', () => {
  it('число проектов со склонением', () => {
    expect(removeWarning(1)).toBe('Тег используется в 1 проекте, он снимется с него.')
    expect(removeWarning(2)).toBe('Тег используется в 2 проектах, он снимется со всех.')
    expect(removeWarning(5)).toBe('Тег используется в 5 проектах, он снимется со всех.')
    expect(removeWarning(21)).toBe('Тег используется в 21 проекте, он снимется со всех.')
  })
})
