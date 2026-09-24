import { describe, expect, it, vi } from 'vitest'
import { createMemoryRouter } from 'react-router'

// Настоящий hash-роутер нужен только браузеру; в тестах маршруты гоняем через память.
vi.mock('react-router', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-router')>()), createHashRouter: () => null }))

const { routes } = await import('./router')
const { Settings } = await import('../screens/Settings')
const { Security } = await import('../screens/Security')
const { Branches } = await import('../screens/Branches')
const { NotFound } = await import('../screens/NotFound')

async function open(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  await vi.waitFor(() => expect(router.state.navigation.state).toBe('idle'))
  await vi.waitFor(() => expect(router.state.initialized).toBe(true))
  const leaf = router.state.matches.at(-1)!.route
  const element = leaf.element as { type: unknown } | undefined
  return { path: router.state.location.pathname, screen: element?.type }
}

describe('маршруты настроек', () => {
  it('#/settings и его разделы', async () => {
    expect(await open('/settings')).toEqual({ path: '/settings', screen: Settings })
    expect(await open('/settings/security')).toEqual({ path: '/settings/security', screen: Security })
    expect(await open('/settings/branches')).toEqual({ path: '/settings/branches', screen: Branches })
  })

  it('старые #/security и #/branches перенаправляют в настройки', async () => {
    expect(await open('/security')).toEqual({ path: '/settings/security', screen: Security })
    expect(await open('/branches')).toEqual({ path: '/settings/branches', screen: Branches })
  })

  it('неизвестный раздел настроек — «не найдено»', async () => {
    expect((await open('/settings/nope')).screen).toBe(NotFound)
  })
})
