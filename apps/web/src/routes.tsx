import { Navigate, type RouteObject } from 'react-router'
import { AppLayout } from './app-layout'
import { LoginPage } from './features/auth/login-page'
import { RedirectIfSignedIn, RequireAuth } from './features/auth/route-guards'
import { SignupPage } from './features/auth/signup-page'
import { VerifyEmailPage } from './features/auth/verify-email-page'
import { CalendarPage } from './features/calendar/calendar-page'
import { DashboardPage } from './features/dashboard/dashboard-page'
import { groupRoutes } from './features/groups/routes'
import { peopleRoutes } from './features/people/routes'
import { ProfilePage } from './features/profile/profile-page'
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
          { path: 'calendar', element: <CalendarPage /> },
          transactionRoutes,
          statementRoutes,
          peopleRoutes,
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]
