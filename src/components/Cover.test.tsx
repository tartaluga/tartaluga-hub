import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const url = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../app/useCoverUrl', () => ({ useCoverUrl: () => url.value }))
import { Cover } from './Cover'

beforeEach(() => {
  url.value = null
})

describe('Cover', () => {
  it('без картинки — генеративная заглушка', () => {
    const html = renderToStaticMarkup(<Cover slug="a" />)
    expect(html).toContain('<svg')
    expect(html).not.toContain('<img')
  })
  it('с картинкой — декоративный img, заглушки нет', () => {
    url.value = 'blob:http://127.0.0.1/abc'
    const html = renderToStaticMarkup(<Cover slug="a" className="x" />)
    expect(html).toMatch(/<img[^>]*src="blob:http:\/\/127\.0\.0\.1\/abc"/)
    expect(html).toContain('alt=""')
    expect(html).toContain('x')
    expect(html).not.toContain('<svg')
  })
  it('muted приглушает картинку', () => {
    url.value = 'blob:x'
    expect(renderToStaticMarkup(<Cover slug="a" muted />)).toMatch(/class="[^"]*muted/)
    expect(renderToStaticMarkup(<Cover slug="a" />)).not.toMatch(/class="[^"]*muted/)
  })
})
