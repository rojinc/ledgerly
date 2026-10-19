import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { PendingGroups } from './pending-groups'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))

const call = vi.mocked(callFunction)
const onJoined = vi.fn()

// Alex added the user as "Sam": the pair is shown by Alex's name, not the group's (#145).
const PENDING = [
  { id: 'g1', type: 'pair', name: 'Sam', counterpartName: 'Alex', archivedAt: null },
  { id: 'g2', type: 'house', name: 'Flat', archivedAt: '2026-09-01T00:00:00.000Z' },
]

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PendingGroups onJoined={onJoined} />
    </QueryClientProvider>,
  )
  return queryClient
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('PendingGroups', () => {
  it('lists the groups the user was added to but hasn’t joined', async () => {
    call.mockResolvedValue({ ok: true, data: { groups: PENDING } })
    renderList()
    const section = await screen.findByRole('region', { name: 'Waiting for you to join' })
    const rows = within(section).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^AlexShared with one person/),
      expect.stringMatching(/^FlatHouse · Archived/),
    ])
    expect(call).toHaveBeenCalledWith('identity', 'GET', '/groups/pending')
  })

  it('joins with POST /groups/{id}/join, then refreshes the user’s groups', async () => {
    let resolveJoin!: () => void
    const joining = new Promise<void>((r) => {
      resolveJoin = r
    })
    call.mockImplementation(async (_fn, method) => {
      if (method === 'GET') return { ok: true as const, data: { groups: PENDING } }
      await joining
      return { ok: true as const, data: { group: {}, member: {} } }
    })
    const queryClient = renderList()
    queryClient.setQueryData(queryKeys.groups('u1'), [])
    const join = await screen.findByRole('button', { name: 'Join Alex' })
    join.focus()
    fireEvent.click(join)
    // Still focusable while it works, and a second press sends nothing more.
    await waitFor(() => expect(join.getAttribute('aria-disabled')).toBe('true'))
    expect(document.activeElement).toBe(join)
    fireEvent.click(join)
    resolveJoin()
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('Alex'))
    expect(call.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1)
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/groups/g1/join')
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.groups('u1'))?.isInvalidated).toBe(true),
    )
    // And the pending list is read again.
    await waitFor(() =>
      expect(call.mock.calls.filter(([, method]) => method === 'GET')).toHaveLength(2),
    )
  })

  it('shows a failed join next to its group', async () => {
    call.mockImplementation(async (_fn, method) =>
      method === 'GET'
        ? { ok: true as const, data: { groups: PENDING } }
        : { ok: false as const, error: { code: 'NOT_A_MEMBER', message: 'You’re not in it.' } },
    )
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Join Flat' }))
    const rows = screen.getAllByRole('listitem')
    expect(await within(rows[1] as HTMLElement).findByRole('alert')).toBeTruthy()
    expect(within(rows[0] as HTMLElement).queryByRole('alert')).toBeNull()
    expect(onJoined).not.toHaveBeenCalled()
    // NOT_A_MEMBER: the list is out of date, so it's read again.
    await waitFor(() =>
      expect(call.mock.calls.filter(([, method]) => method === 'GET')).toHaveLength(2),
    )
  })

  it('shows nothing when there are none, or they can’t be read', async () => {
    call.mockResolvedValue({ ok: true, data: { groups: [] } })
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <PendingGroups onJoined={onJoined} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    cleanup()
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'down' } })
    renderList()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region')).toBeNull()
  })
})
