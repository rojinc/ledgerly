import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { createMemoryRouter, Link, Outlet, RouterProvider, useSearchParams } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { followPageHeading } from './page-heading'

/** Shows the month it's on, as the calendar does, and a link of its own to another page. */
function PageA() {
  const [params] = useSearchParams()
  return (
    <>
      <h1>Page A</h1>
      <p>{params.get('month') ?? 'This month'}</p>
      <Link to="/b">On to B</Link>
    </>
  )
}

/** Shows its h1 only after a moment, as a page does once its data is read. */
function LatePage() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 20)
    return () => clearTimeout(timer)
  }, [])
  return ready ? <h1>Late page</h1> : <p>Loading…</p>
}

/** Bills, as `/bills` and `/bills?groupId=` show it: two pages under one path (#556). */
function BillsPage() {
  const [params] = useSearchParams()
  return params.get('groupId') ? (
    <>
      <h1>Bills · Flat 3</h1>
      <Link to="/bills?groupId=g1&show=paid">Paid</Link>
    </>
  ) : (
    <h1>Bills</h1>
  )
}

/** Shows an h1 of its own while it loads, then the loaded page, with another h1 (#556). */
function SwapPage() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 20)
    return () => clearTimeout(timer)
  }, [])
  return ready ? <LoadedPage /> : <LoadingPage />
}
function LoadingPage() {
  return (
    <div>
      <h1>Delete group</h1>
      <p>Loading…</p>
    </div>
  )
}
function LoadedPage() {
  return (
    <div>
      <h1>Delete Flat 3</h1>
      <button type="button">Delete group</button>
    </div>
  )
}

const routes = [
  {
    element: (
      <>
        <nav>
          <Link to="/b">To B</Link>
          <Link to="/late">To late</Link>
          <Link to="/form">To form</Link>
          <Link to="/a?month=2026-11">Next month</Link>
          <Link to="/none">To none</Link>
          <Link to="/swap">To swap</Link>
          <Link to="/bills">To my bills</Link>
          <Link to="/bills?groupId=g1">To house bills</Link>
        </nav>
        <Outlet />
      </>
    ),
    children: [
      { path: 'a', element: <PageA /> },
      { path: 'b', element: <h1>Page B</h1> },
      { path: 'late', element: <LatePage /> },
      {
        path: 'form',
        element: (
          <>
            <h1>Form page</h1>
            <input aria-label="Name" ref={(input) => input?.focus()} />
          </>
        ),
      },
      { path: 'none', element: <p>No heading</p> },
      { path: 'swap', element: <SwapPage /> },
      { path: 'bills', element: <BillsPage /> },
      { path: 'home', element: <h1 data-title="Home">Hi, Sam</h1> },
    ],
  },
]

let stop = () => {}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const root = document.createElement('div')
  document.body.append(root)
  stop = followPageHeading(router, root)
  render(<RouterProvider router={router} />, { container: root })
}

/** Clicks a link from the keyboard's place: focused first, as a Tab and Enter leave it. */
function follow(name: string) {
  const link = screen.getByRole('link', { name })
  link.focus()
  fireEvent.click(link)
  return link
}

describe('followPageHeading (#539)', () => {
  afterEach(() => {
    stop()
    cleanup()
    document.body.innerHTML = ''
    document.title = ''
  })

  it('names the tab after the h1, and leaves focus alone on the first page', async () => {
    renderAt('/a')
    await waitFor(() => expect(document.title).toBe('Page A · Ledgerly'))
    expect(document.activeElement).toBe(document.body)
  })

  it('focuses the next page’s h1, so where it went is read out', async () => {
    renderAt('/a')
    follow('To B')
    const heading = await screen.findByRole('heading', { name: 'Page B' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(document.title).toBe('Page B · Ledgerly')
  })

  it('focuses the h1 after a link on the page, which is gone with it', async () => {
    renderAt('/a')
    follow('On to B')
    const heading = await screen.findByRole('heading', { name: 'Page B' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('focuses it once: a later change on the page leaves focus alone', async () => {
    renderAt('/a')
    follow('To B')
    const heading = await screen.findByRole('heading', { name: 'Page B' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    // A click on the page's background, then a refresh of what's on it.
    heading.blur()
    heading.after(document.createElement('p'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.activeElement).toBe(document.body)
  })

  it('waits for an h1 that comes once the page has loaded', async () => {
    renderAt('/a')
    follow('To late')
    await waitFor(() => expect(document.title).toBe('Ledgerly'))
    const heading = await screen.findByRole('heading', { name: 'Late page' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(document.title).toBe('Late page · Ledgerly')
  })

  it('leaves focus where the new page put it', async () => {
    renderAt('/a')
    follow('To form')
    await waitFor(() => expect(document.title).toBe('Form page · Ledgerly'))
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  })

  it('leaves focus where the person moved it while the page loaded', async () => {
    renderAt('/a')
    follow('To late')
    const other = screen.getByRole('link', { name: 'To B' })
    other.focus()
    await screen.findByRole('heading', { name: 'Late page' })
    await waitFor(() => expect(document.title).toBe('Late page · Ledgerly'))
    expect(document.activeElement).toBe(other)
  })

  it('keeps focus on a query change, which stays on the page', async () => {
    renderAt('/a')
    await waitFor(() => expect(document.title).toBe('Page A · Ledgerly'))
    const link = follow('Next month')
    expect(await screen.findByText('2026-11')).toBeTruthy()
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.activeElement).toBe(link)
    expect(screen.getByRole('heading', { name: 'Page A' }).hasAttribute('tabindex')).toBe(false)
  })

  it('hands the focus on from an h1 shown while loading to the loaded page’s (#556)', async () => {
    renderAt('/a')
    follow('To swap')
    const loading = await screen.findByRole('heading', { name: 'Delete group' })
    await waitFor(() => expect(document.activeElement).toBe(loading))
    const loaded = await screen.findByRole('heading', { name: 'Delete Flat 3' })
    await waitFor(() => expect(document.activeElement).toBe(loaded))
    expect(document.title).toBe('Delete Flat 3 · Ledgerly')
  })

  it('leaves focus where the person moved it before the loaded page came (#556)', async () => {
    renderAt('/a')
    follow('To swap')
    const loading = await screen.findByRole('heading', { name: 'Delete group' })
    await waitFor(() => expect(document.activeElement).toBe(loading))
    const other = screen.getByRole('link', { name: 'To B' })
    other.focus()
    await screen.findByRole('heading', { name: 'Delete Flat 3' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.activeElement).toBe(other)
  })

  it('counts a change of Bills’ group as a move (#556)', async () => {
    renderAt('/bills?groupId=g1')
    await waitFor(() => expect(document.title).toBe('Bills · Flat 3 · Ledgerly'))
    follow('To my bills')
    const heading = await screen.findByRole('heading', { name: 'Bills' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    follow('To house bills')
    const house = await screen.findByRole('heading', { name: 'Bills · Flat 3' })
    await waitFor(() => expect(document.activeElement).toBe(house))
  })

  it('keeps focus on another query change on Bills (#556)', async () => {
    renderAt('/bills?groupId=g1')
    await waitFor(() => expect(document.title).toBe('Bills · Flat 3 · Ledgerly'))
    const link = follow('Paid')
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.activeElement).toBe(link)
    // Nor later, when the page's h1 changes: no move is waiting for it.
    const heading = screen.getByRole('heading', { name: 'Bills · Flat 3' })
    heading.textContent = 'Bills · Flat 3, 2 due'
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.activeElement).toBe(link)
  })

  it('names a page without an h1 just Ledgerly', async () => {
    renderAt('/a')
    await waitFor(() => expect(document.title).toBe('Page A · Ledgerly'))
    follow('To none')
    await waitFor(() => expect(document.title).toBe('Ledgerly'))
  })

  it('names the tab with the h1’s data-title where it has one', async () => {
    renderAt('/home')
    await waitFor(() => expect(document.title).toBe('Home · Ledgerly'))
  })

  it('stops when asked', async () => {
    renderAt('/a')
    await waitFor(() => expect(document.title).toBe('Page A · Ledgerly'))
    stop()
    const link = follow('To B')
    await screen.findByRole('heading', { name: 'Page B' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.title).toBe('Page A · Ledgerly')
    expect(document.activeElement).toBe(link)
  })
})

// In a browser, the router renders a move in a transition, so the old page can render again (a
// form after its save) before the new one is on the page: a step that act() would flush away.
// Here the router and the page are driven by hand, in that order (#547).
describe('followPageHeading, when the old page renders again first (#539)', () => {
  type Subscriber = Parameters<Parameters<typeof followPageHeading>[0]['subscribe']>[0]
  let subscribers: Subscriber[] = []
  let root: HTMLElement
  let stopIt = () => {}

  /** A page at `/a`, with focus on its form's button, as after a click on Save. */
  function start(page: string) {
    root = document.createElement('div')
    root.innerHTML = page
    document.body.append(root)
    const router = {
      state: { location: { pathname: '/a' } },
      subscribe: (subscriber: Subscriber) => {
        subscribers.push(subscriber)
        return () => {
          subscribers = subscribers.filter((s) => s !== subscriber)
        }
      },
    } as unknown as Parameters<typeof followPageHeading>[0]
    stopIt = followPageHeading(router, root)
    root.querySelector('button')?.focus()
  }

  /** The router's move: its state changes before React renders the new page. */
  function moveTo(pathname: string) {
    for (const subscriber of subscribers) {
      subscriber({ location: { pathname } } as never, {} as never)
    }
  }

  /** Lets the observer see what changed, as the browser does between the two renders. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    stopIt()
    subscribers = []
    document.body.innerHTML = ''
  })

  it('waits past the old page’s h1, and focuses the new page’s', async () => {
    start('<h1>New lend &amp; borrow</h1><p>Adding…</p><button>Add</button>')
    moveTo('/b')
    // The old page renders its saved state before the new page is there.
    const status = root.querySelector('p') as HTMLElement
    status.textContent = 'Added.'
    await settle()
    expect(document.activeElement).toBe(root.querySelector('button'))
    root.innerHTML = '<h1>Sam</h1>'
    await settle()
    expect(document.activeElement).toBe(root.querySelector('h1'))
    expect(document.title).toBe('Sam · Ledgerly')
  })

  it('focuses the same h1 node once its text is the new page’s', async () => {
    start('<h1>Flat 3</h1><button>Open Flat 4</button>')
    const h1 = root.querySelector('h1') as HTMLElement
    moveTo('/b')
    await settle()
    expect(document.activeElement).not.toBe(h1)
    // The same route component: React keeps the node and changes its text.
    h1.textContent = 'Flat 4'
    await settle()
    expect(document.activeElement).toBe(h1)
  })
})
