import { Navigate, type RouteObject } from 'react-router'
import { AppLayout } from './app-layout'
import { DeleteAccountPage } from './features/account/delete-account-page'
import { ActivityPage } from './features/activity/activity-page'
import { LoginPage } from './features/auth/login-page'
import { RecoverCompletePage } from './features/auth/recover-complete-page'
import { RecoverPage } from './features/auth/recover-page'
import { RedirectIfSignedIn, RequireAuth } from './features/auth/route-guards'
import { SignupPage } from './features/auth/signup-page'
import { VerifyEmailPage } from './features/auth/verify-email-page'
import { billRoutes } from './features/bills/routes'
import { CalendarPage } from './features/calendar/calendar-page'
import { DashboardPage } from './features/dashboard/dashboard-page'
import { ExportPage } from './features/export/export-page'
import { groupRoutes } from './features/groups/routes'
import { houseRoutes } from './features/house/routes'
import { peopleRoutes } from './features/people/routes'
import { ProfilePage } from './features/profile/profile-page'
import { scheduleRoutes } from './features/schedules/routes'
import { shiftRoutes } from './features/shifts/routes'
import { statementRoutes } from './features/statements/routes'
import { transactionRoutes } from './features/transactions/routes'

export const routes: RouteObject[] = [
  {
    element: <RedirectIfSignedIn />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'signup', element: <SignupPage /> },
      { path: 'recover', element: <RecoverPage /> },
    ],
  },
  { path: 'verify-email', element: <VerifyEmailPage /> },
  // Guards itself: it stays up to say the account was deleted once there's no user.
  { path: 'account/delete', element: <DeleteAccountPage /> },
  // No guard: someone signed in may open the emailed link.
  { path: 'recover/complete', element: <RecoverCompletePage /> },
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
          scheduleRoutes,
          billRoutes,
          { path: 'activity', element: <ActivityPage /> },
          { path: 'export', element: <ExportPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]
