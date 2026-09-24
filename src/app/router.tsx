import { createHashRouter, redirect, type RouteObject } from 'react-router'
import { Shell } from './Shell'
import { Today } from '../screens/Today'
import { Projects } from '../screens/Projects'
import { Project } from '../screens/Project'
import { Ideas } from '../screens/Ideas'
import { Stats } from '../screens/Stats'
import { NotFound } from '../screens/NotFound'
import { Security } from '../screens/Security'
import { Branches } from '../screens/Branches'
import { Settings } from '../screens/Settings'

export const routes: RouteObject[] = [
  {
    element: <Shell />,
    children: [
      { index: true, element: <Today /> },
      { path: 'projects', element: <Projects /> },
      { path: 'projects/:slug', element: <Project /> },
      { path: 'ideas', element: <Ideas /> },
      { path: 'stats', element: <Stats /> },
      { path: 'settings', element: <Settings /> },
      { path: 'settings/security', element: <Security /> },
      { path: 'settings/branches', element: <Branches /> },
      // Старые адреса (закладки, ссылки из плашек) ведут в настройки.
      { path: 'security', loader: () => redirect('/settings/security') },
      { path: 'branches', loader: () => redirect('/settings/branches') },
      { path: '*', element: <NotFound /> },
    ],
  },
]

// Hash-роутинг (#/projects): адреса не зависят от сервера статики (ADR-006).
export const router = createHashRouter(routes)
