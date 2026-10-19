import { Navigate, type RouteObject } from 'react-router'
import { AppLayout } from './app-layout'
import { ActivityPage } from './features/activity/activity-page'
import { LoginPage } from './features/auth/login-page'
import { RedirectIfSignedIn, RequireAuth } from './features/auth/route-guards'
import { SignupPage } from './features/auth/signup-page'
import { VerifyEmailPage } from './features/auth/verify-email-page'
import { billRoutes } from './features/bills/routes'
import { CalendarPage } from './features/calendar/calendar-page'
import { DashboardPage } from './features/dashboard/dashboard-page'
import { groupRoutes } from './features/groups/routes'
import { houseRoutes } from './features/house/routes'
import { InvitePage } from './features/invites/invite-page'
import { peopleRoutes } from './features/people/routes'
import { ProfilePage } from './features/profile/profile-page'
import { shiftRoutes } from './features/shifts/routes'
import { statementRoutes } from './features/statements/routes'
import { transactionRoutes } from './features/transactions/routes'

export const routes: RouteObject[] = [
  {
    element: <RedirectIfSignedIn />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'signup', element: <SignupPage /> },
    ],
  },
  { path: 'verify-email', element: <VerifyEmailPage /> },
  { path: 'invite', element: <InvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        // One line per feature route.
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'profile', element: <ProfilePage /> },
          groupRoutes,
          houseRoutes,
          { path: 'calendar', element: <CalendarPage /> },
          transactionRoutes,
          statementRoutes,
          peopleRoutes,
          shiftRoutes,
          billRoutes,
          { path: 'activity', element: <ActivityPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]
