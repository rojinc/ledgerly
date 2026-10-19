import type { RouteObject } from 'react-router'
import { EditSchedulePage, NewSchedulePage } from './schedule-form-page'
import { SchedulesPage } from './schedules-page'

/** `/schedules` and its pages, mounted with one line in src/routes.tsx. */
export const scheduleRoutes: RouteObject = {
  path: 'schedules',
  children: [
    { index: true, element: <SchedulesPage /> },
    { path: 'new', element: <NewSchedulePage /> },
    { path: ':scheduleId', element: <EditSchedulePage /> },
  ],
}
