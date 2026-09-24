import { describe, expect, it } from 'vitest'
import { syncThemeColor, THEME_COLOR } from './ThemeSwitch'
import indexHtml from '../../index.html?raw'

/** Метки theme-color из настоящего index.html как простые объекты с getAttribute/setAttribute. */
function metasFromIndex() {
  const tags = indexHtml.match(/<meta name="theme-color"[^>]*>/g) ?? []
  return tags.map((tag) => {
    const attrs = new Map([...tag.matchAll(/(\w[\w-]*)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]))
    return {
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      attrs,
    }
  })
}

function docOf(metas: ReturnType<typeof metasFromIndex>) {
  return { querySelectorAll: () => metas } as unknown as Pick<Document, 'querySelectorAll'>
}

describe('meta theme-color следует ручной теме', () => {
  it('в index.html две метки: для тёмной и светлой системной темы, с цветами фона', () => {
    const metas = metasFromIndex()
    expect(metas.map((m) => [m.attrs.get('media'), m.attrs.get('content')])).toEqual([
      ['(prefers-color-scheme: dark)', THEME_COLOR.dark],
      ['(prefers-color-scheme: light)', THEME_COLOR.light],
    ])
  })

  it('ручная тема ставит свой цвет в обе метки, «как в системе» возвращает исходные', () => {
    const metas = metasFromIndex()
    const doc = docOf(metas)
    syncThemeColor('light', doc)
    expect(metas.map((m) => m.attrs.get('content'))).toEqual([THEME_COLOR.light, THEME_COLOR.light])
    syncThemeColor('dark', doc)
    expect(metas.map((m) => m.attrs.get('content'))).toEqual([THEME_COLOR.dark, THEME_COLOR.dark])
    syncThemeColor('auto', doc)
    expect(metas.map((m) => m.attrs.get('content'))).toEqual([THEME_COLOR.dark, THEME_COLOR.light])
  })
})
