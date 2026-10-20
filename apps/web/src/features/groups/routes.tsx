import type { RouteObject } from 'react-router'
import { DeleteGroupPage } from './delete-group-page'
import { EmployerSettingsPage } from './employer-settings-page'
import { GroupsPage } from './groups-page'
import { NewEmployerPage } from './new-employer-page'

/** `/groups` and its pages, mounted with one line in src/routes.tsx. */
export const groupRoutes: RouteObject = {
  path: 'groups',
  children: [
    { index: true, element: <GroupsPage /> },
    { path: 'new-employer', element: <NewEmployerPage /> },
    { path: ':groupId/settings', element: <EmployerSettingsPage /> },
    { path: ':groupId/delete', element: <DeleteGroupPage /> },
  ],
}
