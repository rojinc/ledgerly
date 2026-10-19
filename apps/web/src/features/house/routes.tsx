import type { RouteObject } from 'react-router'
import { HousePage } from './house-page'
import { NewHousePage } from './new-house-page'

/** `/groups/new-house` and a house's page, mounted with one line in src/routes.tsx. */
export const houseRoutes: RouteObject = {
  path: 'groups',
  children: [
    { path: 'new-house', element: <NewHousePage /> },
    { path: ':groupId', element: <HousePage /> },
  ],
}
