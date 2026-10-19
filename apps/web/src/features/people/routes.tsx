import type { RouteObject } from 'react-router'
import { NewPairPage } from './new-pair-page'
import { PairPage } from './pair-page'
import { PeoplePage } from './people-page'

/** `/people`: lend & borrow with one person (#34), mounted with one line in src/routes.tsx. */
export const peopleRoutes: RouteObject = {
  path: 'people',
  children: [
    { index: true, element: <PeoplePage /> },
    { path: 'new', element: <NewPairPage /> },
    { path: ':groupId', element: <PairPage /> },
  ],
}
