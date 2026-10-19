import type { RouteObject } from 'react-router'
import { NewShiftPage, ShiftPage } from './shift-page'
import { TodayPage } from './today-page'

export const shiftRoutes: RouteObject = {
  children: [
    { path: 'today', element: <TodayPage /> },
    { path: 'shifts/new', element: <NewShiftPage /> },
    { path: 'shifts/:shiftId', element: <ShiftPage /> },
  ],
}
