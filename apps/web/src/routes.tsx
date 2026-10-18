import { Navigate, type RouteObject } from 'react-router'
import { AppLayout } from './app-layout'
import { LoginPage } from './features/auth/login-page'
import { RedirectIfSignedIn, RequireAuth } from './features/auth/route-guards'
import { SignupPage } from './features/auth/signup-page'
import { VerifyEmailPage } from './features/auth/verify-email-page'
import { groupRoutes } from './features/groups/routes'
import { ProfilePage } from './features/profile/profile-page'
import { HomePage } from './home-page'

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
          { index: true, element: <HomePage /> },
          { path: 'profile', element: <ProfilePage /> },
          groupRoutes,
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]
