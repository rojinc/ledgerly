import type { Groups } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { GroupName, useSortedByName } from './use-group-name'

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

function SortedNames({ groups }: { groups: Pick<Groups, '$id' | 'type' | 'name'>[] }) {
  return (
    <ul>
      {useSortedByName(groups).map((group) => (
        <li key={group.$id}>
          <GroupName group={group} />
        </li>
      ))}
    </ul>
  )
}

describe('useSortedByName', () => {
  it('sorts by the names shown, a pair by its other member once the members are read (#147 O11)', async () => {
    listRows.mockResolvedValue({ total: MEMBERS.length, rows: MEMBERS } as never)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SortedNames
          groups={[
            { $id: 'g2', type: 'house', name: 'Beach house' },
            { $id: 'g1', type: 'pair', name: 'Sam' },
            { $id: 'g3', type: 'employer', name: 'Zed Cafe' },
          ]}
        />
      </QueryClientProvider>,
    )
    const names = () => screen.getAllByRole('listitem').map((item) => item.textContent)
    // Until then, the pair sorts under its own name.
    expect(names()).toEqual(['Beach house', 'Sam', 'Zed Cafe'])
    await waitFor(() => expect(names()).toEqual(['Alex', 'Beach house', 'Zed Cafe']))
    // The rows read the members; sorting reads no more.
    expect(listRows).toHaveBeenCalledTimes(1)
  })

  it('leaves the members query able to reload after the list renders again', async () => {
    listRows.mockResolvedValue({ total: MEMBERS.length, rows: MEMBERS } as never)
    const queryClient = new QueryClient()
    const groups = [{ $id: 'g1', type: 'pair' as const, name: 'Sam' }]
    const page = () => (
      <QueryClientProvider client={queryClient}>
        <SortedNames groups={[...groups]} />
      </QueryClientProvider>
    )
    const { rerender } = render(page())
    await waitFor(() => expect(screen.getByRole('listitem').textContent).toBe('Alex'))
    // The sort's observer now has the last word on the shared query's options.
    rerender(page())
    await act(() => queryClient.invalidateQueries({ queryKey: ['members', 'g1'] }))
    await waitFor(() => expect(listRows).toHaveBeenCalledTimes(2))
    expect(queryClient.getQueryState(['members', 'g1'])?.status).toBe('success')
  })
})
