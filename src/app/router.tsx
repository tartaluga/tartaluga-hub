import { createHashRouter } from 'react-router'
import { Shell } from './Shell'
import { Today } from '../screens/Today'
import { Projects } from '../screens/Projects'
import { Project } from '../screens/Project'
import { Ideas } from '../screens/Ideas'
import { Stats } from '../screens/Stats'
import { NotFound } from '../screens/NotFound'

// Hash-роутинг (#/projects): GitHub Pages не умеет отдавать index.html на любой путь (ADR-006).
export const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <Today /> },
      { path: 'projects', element: <Projects /> },
      { path: 'projects/:slug', element: <Project /> },
      { path: 'ideas', element: <Ideas /> },
      { path: 'stats', element: <Stats /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])
