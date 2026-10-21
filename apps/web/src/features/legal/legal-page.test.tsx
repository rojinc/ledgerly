import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { routes } from '../../routes'
import { AgreeNotice, LegalLinks } from './legal-links'

// The app's routes import every feature: the client's other services answer nothing here.
vi.mock('../../lib/appwrite', () => {
  const idle = () => new Proxy({}, { get: () => () => undefined })
  return {
    account: { get: vi.fn() },
    client: idle(),
    functions: idle(),
    tablesDB: idle(),
    teams: idle(),
    realtime: idle(),
    storage: idle(),
    DATABASE_ID: 'main',
  }
})

/** The app's own routes, signed in or out: the pages sit outside both guards. */
function renderAt(path: string, signedIn: boolean) {
  if (signedIn) vi.mocked(account.get).mockResolvedValue({ $id: 'u1' } as never)
  else vi.mocked(account.get).mockRejectedValue(new AppwriteException('No session', 401))
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href')

describe('the privacy policy and terms pages (#566)', () => {
  afterEach(cleanup)

  for (const [path, title, what, signedIn] of [
    ['/privacy', 'Privacy policy', 'The privacy policy is being written with a lawyer', false],
    ['/terms', 'Terms of use', 'The terms of use are being written with a lawyer', false],
    ['/privacy', 'Privacy policy', 'The privacy policy is being written with a lawyer', true],
    ['/terms', 'Terms of use', 'The terms of use are being written with a lawyer', true],
  ] as const) {
    it(`shows ${path} signed ${signedIn ? 'in' : 'out'}, with its h1, its file's text and a way back`, async () => {
      const router = renderAt(path, signedIn)
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy()
      expect(router.state.location.pathname).toBe(path)
      // Today's placeholder says it isn't the real text yet, with its version and date.
      expect(screen.getByText(new RegExp(`^${what}`))).toBeTruthy()
      expect(screen.getByText('Version 0 (placeholder), 21 October 2026')).toBeTruthy()
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(href('Back to Ledgerly')).toBe('/')
      // Without the app's menu, signed in too.
      expect(screen.queryByRole('navigation')).toBeNull()
    })
  }
})

describe('the links to them (#566)', () => {
  afterEach(cleanup)

  it('says what creating an account agrees to, with both links', () => {
    render(<AgreeNotice />, { wrapper: Router })
    expect(screen.getByText(/^By creating an account, you agree to the/).textContent).toBe(
      'By creating an account, you agree to the Terms of use and the Privacy policy.',
    )
    expect(href('Terms of use')).toBe('/terms')
    expect(href('Privacy policy')).toBe('/privacy')
  })

  it('links both pages', () => {
    render(<LegalLinks />, { wrapper: Router })
    expect(href('Terms of use')).toBe('/terms')
    expect(href('Privacy policy')).toBe('/privacy')
  })
})

function Router({ children }: { children: React.ReactNode }) {
  return <RouterProvider router={createMemoryRouter([{ path: '*', element: children }])} />
}
