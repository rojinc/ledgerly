import type { Groups } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { GroupName } from './use-group-name'

vi.mock('../../lib/appwrite', () => ({ DATABASE_ID: 'main', tablesDB: { listRows: vi.fn() } }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
// The viewer's person; empty while bootstrap is still loading.
let mockPersonId = 'p1'
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: mockPersonId } }),
}))

const listRows = vi.mocked(tablesDB.listRows)

// Alex created the pair and named it after the viewer, Sam (p1).
const MEMBERS = [
  { $id: 'm2', groupId: 'g1', personId: 'p2', displayName: 'Alex' },
  { $id: 'm1', groupId: 'g1', personId: 'p1', displayName: 'Sam' },
]

function show(group: Pick<Groups, '$id' | 'type' | 'name'>) {
  listRows.mockResolvedValue({ total: MEMBERS.length, rows: MEMBERS } as never)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <p data-testid="name">
        <GroupName group={group} />
      </p>
    </QueryClientProvider>,
  )
  return () => screen.getByTestId('name').textContent
}

afterEach(() => {
  cleanup()
  mockPersonId = 'p1'
  vi.resetAllMocks()
})

describe('useGroupName', () => {
  it('names a pair group by its other member, once the members are read', async () => {
    const name = show({ $id: 'g1', type: 'pair', name: 'Sam' })
    // Until then, the group's own name.
    expect(name()).toBe('Sam')
    await waitFor(() => expect(name()).toBe('Alex'))
  })

  it('keeps the group’s name until the viewer’s person is known', async () => {
    mockPersonId = ''
    const name = show({ $id: 'g1', type: 'pair', name: 'Sam' })
    await waitFor(() => expect(listRows).toHaveBeenCalled())
    await act(async () => {})
    // Either member could be the other one: the viewer's own row isn't shown.
    expect(name()).toBe('Sam')
  })

  it.each(['employer', 'house', 'personal'] as const)(
    'keeps a %s group’s name and reads no members',
    async (type) => {
      const name = show({ $id: 'g1', type, name: 'Acme' })
      await act(async () => {})
      expect(name()).toBe('Acme')
      expect(listRows).not.toHaveBeenCalled()
    },
  )
})
