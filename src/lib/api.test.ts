import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, BRANCH_NAME, deleteSession, problemFiles } from './api'

describe('problemFiles', () => {
  it('422: файлы с причинами', () => {
    const e = new ApiError(422, 'validation', 'x', {
      files: [
        { path: 'projects/a.json', error: 'нет name' },
        { path: '.github/x.yml', error: 'вне данных' },
      ],
    })
    expect(problemFiles(e)).toEqual([
      { path: 'projects/a.json', error: 'нет name' },
      { path: '.github/x.yml', error: 'вне данных' },
    ])
  })

  it('409: просто пути', () => {
    expect(problemFiles(new ApiError(409, 'conflict', 'x', { files: ['settings.json'] }))).toEqual([{ path: 'settings.json' }])
  })

  it('мусор в details не ломает экран', () => {
    expect(problemFiles(new ApiError(409, 'conflict', 'x', { files: [null, 5, { path: 7 }] }))).toEqual([])
    expect(problemFiles(new ApiError(409, 'conflict', 'x'))).toEqual([])
  })
})

describe('BRANCH_NAME совпадает с правилом сервера', () => {
  it.each(['a', 'feature-1', 'x'.repeat(40)])('%s — можно', (n) => expect(BRANCH_NAME.test(n)).toBe(true))
  it.each(['', '-a', 'A', 'a/b', 'a_b', 'x'.repeat(41), 'ветка'])('%s — нельзя', (n) => expect(BRANCH_NAME.test(n)).toBe(false))
})

describe('deleteSession', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('DELETE по хэшу сессии с X-Hub', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const id = 'ab'.repeat(32)
    await expect(deleteSession(id)).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${id}`,
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'X-Hub': '1' }) }),
    )
  })

  it.each(['', 'AB'.repeat(32), 'ab'.repeat(31), '../me', `${'ab'.repeat(32)}/x`])('%s — без запроса к серверу', async (id) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(deleteSession(id)).rejects.toBeInstanceOf(ApiError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ошибка сервера доходит как ApiError со статусом и кодом', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Такого входа уже нет' } }), { status: 404 })))
    const err = await deleteSession('0'.repeat(64)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('id длиннее 64 или с пробелом — без запроса', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const id of ['a'.repeat(65), ` ${'a'.repeat(64)}`, `${'a'.repeat(64)}
`]) await expect(deleteSession(id)).rejects.toBeInstanceOf(ApiError)
    expect(fetch).not.toHaveBeenCalled()
  })
})
