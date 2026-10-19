import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type ErrorCode, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { formatDate } from '../statements/invoice-view'
import { houseRoutes } from './routes'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
// The viewer's person: Alex (p1).
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
// Settle up has its own tests (settle-up.test.tsx) and its own ledger call.
vi.mock('./settle-up', () => ({ SettleUp: () => <p>Settle up section</p> }))

const call = vi.mocked(callFunction)
const listRows = vi.mocked(tablesDB.listRows)
const getRow = vi.mocked(tablesDB.getRow)

// 22:00 UTC on 18 October: already the 19th in Sydney.
const NOW = new Date('2026-10-18T22:00:00.000Z')

const HOUSE = {
  $id: 'g1',
  type: 'house',
  name: 'Flat 3',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  statementCycle: 'monthly',
  settingsJson: JSON.stringify({ type: 'house', autoFinalize: false, defaultBillSplit: 'days' }),
  archivedAt: null,
} as Groups

function member(id: string, extra: Partial<Members>): Members {
  return {
    $id: id,
    groupId: 'g1',
    displayName: id,
    role: 'member',
    status: 'active',
    joinedOn: '2026-08-01',
    leftOn: null,
    ...extra,
  } as Members
}

/** What the database holds; tests change it to show a write landing. */
let stored: { group: Groups; members: Members[] }

function seed(myRole: Members['role'] = 'admin', group: Partial<Groups> = {}) {
  stored = {
    group: { ...HOUSE, ...group },
    members: [
      member('m3', {
        personId: 'p3',
        displayName: 'Sam',
        status: 'placeholder',
        joinedOn: '2026-09-01',
      }),
      member('m1', { personId: 'p1', displayName: 'Alex', role: myRole }),
      member('m2', {
        personId: 'p2',
        displayName: 'Jo',
        role: 'viewer',
        status: 'left',
        joinedOn: '2026-03-01',
        leftOn: '2026-09-30',
      }),
    ],
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  seed()
  getRow.mockImplementation((async () => stored.group) as never)
  // useMyMember asks for one person's row; useMembers for the whole house.
  listRows.mockImplementation((async ({ queries }: { queries: string[] }) => {
    const person = queries.map((query) => JSON.parse(query)).find((q) => q.attribute === 'personId')
    const rows = person
      ? stored.members.filter((row) => row.personId === person.values[0])
      : stored.members
    return { total: rows.length, rows }
  }) as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

function renderAt(path: string) {
  const router = createMemoryRouter([houseRoutes, { path: '*', element: null }], {
    initialEntries: [path],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

function ok(data: unknown): Result<unknown> {
  return { ok: true, data }
}

function refused(code: ErrorCode, message = 'Refused.'): Result<unknown> {
  return { ok: false, error: { code, message } }
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function input(label: string | RegExp) {
  return screen.getByLabelText(label) as HTMLInputElement
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** The one call made: function, method, path and body. */
function sent() {
  expect(call).toHaveBeenCalledTimes(1)
  return call.mock.calls[0]?.slice(0, 4)
}

async function row(name: string) {
  const items = await screen.findAllByRole('listitem')
  const found = items.find((item) => within(item).queryByText(new RegExp(`^${name}`)))
  if (!found) throw new Error(`No row for ${name}`)
  return found
}

describe('NewHousePage', () => {
  it('creates a house with the defaults, then opens it', async () => {
    call.mockResolvedValue(ok({ group: { ...HOUSE, $id: 'new1' }, members: [] }))
    const { router, queryClient } = renderAt('/groups/new-house')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    type('House name', ' Flat 3 ')
    click('Create house')
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/new1'))
    // The groups list shows the new house.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
    const [fn, method, path, body] = sent() as [string, string, string, { id: string }]
    expect([fn, method, path]).toEqual(['groups', 'POST', '/groups'])
    // Currency, time zone and region come from the profile, on the server.
    expect(body).toStrictEqual({
      id: body.id,
      type: 'house',
      name: 'Flat 3',
      statementCycle: 'monthly',
      settings: { type: 'house', autoFinalize: false, defaultBillSplit: 'days' },
    })
  })

  it('sends an equal split, no monthly divide and auto-finalize as chosen', async () => {
    call.mockResolvedValue(ok({ group: { ...HOUSE, $id: 'new1' }, members: [] }))
    renderAt('/groups/new-house')
    type('House name', 'Flat 3')
    fireEvent.change(screen.getByLabelText('Split bills'), { target: { value: 'equal' } })
    fireEvent.click(screen.getByLabelText('Close each month with a divide'))
    fireEvent.click(screen.getByLabelText(/Finalize the divide automatically/))
    click('Create house')
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(sent()?.[3]).toMatchObject({
      statementCycle: 'none',
      settings: { type: 'house', autoFinalize: true, defaultBillSplit: 'equal' },
    })
  })

  it('needs a name, and keeps its ID when a refused try is sent again', async () => {
    renderAt('/groups/new-house')
    click('Create house')
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    call.mockResolvedValue(refused('CONFLICT'))
    type('House name', 'Flat 3')
    click('Create house')
    expect(await screen.findByText(/This house may already exist/)).toBeTruthy()
    call.mockResolvedValue(refused('NOT_FOUND', 'Set up your account first.'))
    click('Create house')
    expect(await screen.findByText('Set up your account first.')).toBeTruthy()
    const ids = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })
})

describe('HousePage', () => {
  it('lists housemates by name with role and status in words, and nothing else about them', async () => {
    renderAt('/groups/g1')
    expect(await screen.findByRole('heading', { name: 'Flat 3', level: 1 })).toBeTruthy()
    const list = await screen.findByRole('list')
    const items = await within(list).findAllByRole('listitem')
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Alex (you)',
      'Jo',
      'Sam',
    ])
    expect(
      within(items[0] as HTMLElement).getByText(`Admin · Moved in ${formatDate('2026-08-01')}`),
    ).toBeTruthy()
    expect(
      within(items[1] as HTMLElement).getByText(`Viewer · Moved out ${formatDate('2026-09-30')}`),
    ).toBeTruthy()
    // A placeholder reads the same whether or not they have an account (D-016).
    expect(
      within(items[2] as HTMLElement).getByText(
        `Member · Not joined yet · Moved in ${formatDate('2026-09-01')}`,
      ),
    ).toBeTruthy()
  })

  it('sends other group types to their own page', async () => {
    seed('admin', { type: 'employer' })
    const { router } = renderAt('/groups/g1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g1/settings'))
    cleanup()
    seed('admin', { type: 'pair' })
    const pair = renderAt('/groups/g1')
    await waitFor(() => expect(pair.router.state.location.pathname).toBe('/people/g1'))
  })

  it('says when the house can’t be loaded', async () => {
    getRow.mockRejectedValue(new Error('offline'))
    renderAt('/groups/g1')
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'We couldn’t load this house. Reload the page to try again.',
    )
  })

  describe('who sees what', () => {
    it('gives an admin every action, except removing themselves', async () => {
      renderAt('/groups/g1')
      const alex = await row('Alex')
      expect(within(alex).getByRole('button', { name: 'Change' })).toBeTruthy()
      expect(within(alex).queryByRole('button', { name: 'Remove' })).toBeNull()
      const sam = await row('Sam')
      expect(within(sam).getByRole('button', { name: 'Moved out' })).toBeTruthy()
      expect(within(sam).getByRole('button', { name: 'Remove' })).toBeTruthy()
      // Jo has moved out already.
      expect(within(await row('Jo')).queryByRole('button', { name: 'Moved out' })).toBeNull()
      expect(screen.getByLabelText('Role')).toBeTruthy()
      expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy()
      expect(screen.getByRole('region', { name: 'Archive group' })).toBeTruthy()
      expect(screen.getByRole('region', { name: 'Leave this house' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Add expense' }).getAttribute('href')).toBe(
        '/transactions/new?groupId=g1',
      )
      expect(screen.getByText('Settle up section')).toBeTruthy()
    })

    it('lets a member add people with the default role, and nothing else', async () => {
      seed('member')
      renderAt('/groups/g1')
      await row('Alex')
      expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
      expect(screen.getByRole('region', { name: 'Add a housemate' })).toBeTruthy()
      expect(screen.queryByLabelText('Role')).toBeNull()
      expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
      expect(screen.queryByRole('region', { name: 'Archive group' })).toBeNull()
      expect(screen.getByRole('region', { name: 'Leave this house' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Add expense' })).toBeTruthy()
    })

    it('lets a viewer only look, and leave', async () => {
      seed('viewer')
      renderAt('/groups/g1')
      await row('Alex')
      expect(screen.queryByRole('region', { name: 'Add a housemate' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
      expect(screen.getByRole('region', { name: 'Leave this house' })).toBeTruthy()
      expect(screen.queryByRole('link', { name: 'Add expense' })).toBeNull()
      // Everyone can read the house's divides (#166).
      expect(screen.getByRole('link', { name: 'Statements' }).getAttribute('href')).toBe(
        '/groups/g1/statements',
      )
    })

    it('makes an archived house read-only for everyone', async () => {
      seed('admin', { archivedAt: '2026-10-01T00:00:00.000Z' })
      renderAt('/groups/g1')
      expect(await screen.findByText(/This group is archived/)).toBeTruthy()
      await row('Alex')
      expect(screen.queryAllByRole('button')).toEqual([])
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Add expense' })).toBeNull()
    })
  })

  describe('adding a housemate', () => {
    it('sends the name, email, role and today in the house’s time zone', async () => {
      call.mockResolvedValue(ok(member('m4', { displayName: 'Lee', status: 'placeholder' })))
      const { queryClient } = renderAt('/groups/g1')
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      await row('Alex')
      // 22:00 UTC on the 18th is the 19th in Sydney.
      expect(input('Moved in').value).toBe('2026-10-19')
      type('Name', ' Lee ')
      type('Email (optional)', 'lee@example.com')
      fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
      click('Add housemate')
      expect(await screen.findByText('Added Lee.')).toBeTruthy()
      expect(sent()).toEqual([
        'groups',
        'POST',
        '/groups/g1/members',
        { displayName: 'Lee', email: 'lee@example.com', role: 'admin', joinedOn: '2026-10-19' },
      ])
      // Ready for the next one.
      expect(input('Name').value).toBe('')
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.members('g1') })
    })

    it('keeps Add housemate focusable while it saves, and sends once', async () => {
      let answer: (result: Result<unknown>) => void = () => {}
      call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
      renderAt('/groups/g1')
      await row('Alex')
      type('Name', 'Lee')
      const add = screen.getByRole('button', { name: 'Add housemate' })
      fireEvent.click(add)
      expect(await screen.findByRole('button', { name: 'Adding…' })).toBe(add)
      // aria-disabled, not disabled, so the button keeps focus (jsdom doesn't move it either way).
      expect(add.getAttribute('aria-disabled')).toBe('true')
      expect(add.hasAttribute('disabled')).toBe(false)
      fireEvent.click(add)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(call).toHaveBeenCalledTimes(1)
      answer(ok(member('m4', { displayName: 'Lee', status: 'placeholder' })))
      expect(await screen.findByText('Added Lee.')).toBeTruthy()
    })

    it('defaults to today in a UTC house too', async () => {
      seed('admin', { timezone: 'UTC' })
      renderAt('/groups/g1')
      await row('Alex')
      expect(input('Moved in').value).toBe('2026-10-18')
    })

    it('leaves the role out for a member, and an empty email or phone', async () => {
      seed('member')
      call.mockResolvedValue(ok(member('m4', { displayName: 'Lee', status: 'placeholder' })))
      renderAt('/groups/g1')
      await row('Alex')
      type('Name', 'Lee')
      type('Moved in', '2026-10-01')
      click('Add housemate')
      await screen.findByText('Added Lee.')
      expect(sent()?.[3]).toStrictEqual({ displayName: 'Lee', joinedOn: '2026-10-01' })
    })

    it('checks the form, and says when they’re already in the house', async () => {
      renderAt('/groups/g1')
      await row('Alex')
      type('Email (optional)', 'not an email')
      click('Add housemate')
      expect(await screen.findByText('Enter an email like sam@example.com')).toBeTruthy()
      expect(screen.getByText('Required')).toBeTruthy()
      expect(call).not.toHaveBeenCalled()
      call.mockResolvedValue(refused('CONFLICT', 'This person is already in the group.'))
      type('Name', 'Sam')
      type('Email (optional)', 'sam@example.com')
      click('Add housemate')
      expect(await screen.findByText('They’re already in this house.')).toBeTruthy()
    })
  })

  describe('admin actions', () => {
    it('changes only what was changed', async () => {
      call.mockResolvedValue(ok({}))
      const { queryClient } = renderAt('/groups/g1')
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      const sam = await row('Sam')
      // Every row has the same buttons, each described by the housemate's name.
      expect(within(sam).getByRole('button', { name: 'Change', description: 'Sam' })).toBeTruthy()
      expect(within(sam).getByRole('button', { name: 'Remove', description: 'Sam' })).toBeTruthy()
      fireEvent.click(within(sam).getByRole('button', { name: 'Change' }))
      // Focus moves into the form.
      expect(document.activeElement).toBe(within(sam).getByLabelText('Name'))
      fireEvent.change(within(sam).getByLabelText('Role'), { target: { value: 'admin' } })
      fireEvent.click(within(sam).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalled())
      expect(sent()).toEqual(['groups', 'PATCH', '/groups/g1/members/m3', { role: 'admin' }])
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
      // Back to the row, with focus on the button that opened the form.
      await waitFor(() =>
        expect(document.activeElement).toBe(within(sam).getByRole('button', { name: 'Change' })),
      )
    })

    it('sends nothing when nothing changed, and keeps a moved-out viewer’s role', async () => {
      renderAt('/groups/g1')
      const jo = await row('Jo')
      fireEvent.click(within(jo).getByRole('button', { name: 'Change' }))
      expect(within(jo).queryByLabelText('Role')).toBeNull()
      fireEvent.change(within(jo).getByLabelText('Moved in'), { target: { value: '2026-10-01' } })
      fireEvent.click(within(jo).getByRole('button', { name: 'Save' }))
      expect(
        await within(jo).findByText(
          `Must be on or before they moved out (${formatDate('2026-09-30')})`,
        ),
      ).toBeTruthy()
      fireEvent.change(within(jo).getByLabelText('Moved in'), { target: { value: '2026-03-01' } })
      fireEvent.click(within(jo).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(within(jo).queryByRole('button', { name: 'Save' })).toBeNull())
      expect(call).not.toHaveBeenCalled()
    })

    it('shows the server’s answer when the last joined admin steps down', async () => {
      call.mockResolvedValue(
        refused('VALIDATION_FAILED', 'The group needs at least one admin who has joined.'),
      )
      renderAt('/groups/g1')
      const alex = await row('Alex')
      fireEvent.click(within(alex).getByRole('button', { name: 'Change' }))
      fireEvent.change(within(alex).getByLabelText('Role'), { target: { value: 'member' } })
      fireEvent.click(within(alex).getByRole('button', { name: 'Save' }))
      expect(
        await within(alex).findByText('The group needs at least one admin who has joined.'),
      ).toBeTruthy()
    })

    it('says so and focuses the heading when an admin steps down to member', async () => {
      call.mockImplementation(async () => {
        stored.members = stored.members.map((row) =>
          row.$id === 'm1' ? { ...row, role: 'member' } : row,
        )
        return ok({})
      })
      renderAt('/groups/g1')
      const alex = await row('Alex')
      fireEvent.click(within(alex).getByRole('button', { name: 'Change' }))
      fireEvent.change(within(alex).getByLabelText('Role'), { target: { value: 'member' } })
      fireEvent.click(within(alex).getByRole('button', { name: 'Save' }))
      expect(await screen.findByText('Your role here is now Member.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Flat 3', level: 1 }))
    })

    it('closes an open form and says why when the house is archived meanwhile', async () => {
      call.mockImplementation(async () => {
        stored.group = { ...stored.group, archivedAt: '2026-10-18T21:00:00.000Z' }
        return refused('ARCHIVED', 'Group is archived')
      })
      renderAt('/groups/g1')
      const sam = await row('Sam')
      fireEvent.click(within(sam).getByRole('button', { name: 'Change' }))
      fireEvent.change(within(sam).getByLabelText('Name'), { target: { value: 'Samira' } })
      fireEvent.click(within(sam).getByRole('button', { name: 'Save' }))
      expect(await screen.findByText(/This group is archived/)).toBeTruthy()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Flat 3', level: 1 }))
    })

    it('marks someone as moved out, today in the house’s time zone by default', async () => {
      call.mockResolvedValue(ok({}))
      renderAt('/groups/g1')
      const sam = await row('Sam')
      fireEvent.click(within(sam).getByRole('button', { name: 'Moved out' }))
      const date = within(sam).getByLabelText('Moved out') as HTMLInputElement
      expect(date.value).toBe('2026-10-19')
      fireEvent.change(date, { target: { value: '2026-08-31' } })
      fireEvent.click(within(sam).getByRole('button', { name: 'Mark as moved out' }))
      expect(
        await within(sam).findByText(
          `Must be on or after they moved in (${formatDate('2026-09-01')})`,
        ),
      ).toBeTruthy()
      expect(call).not.toHaveBeenCalled()
      fireEvent.change(date, { target: { value: '2026-10-19' } })
      fireEvent.click(within(sam).getByRole('button', { name: 'Mark as moved out' }))
      await waitFor(() => expect(call).toHaveBeenCalled())
      expect(sent()).toEqual(['groups', 'PATCH', '/groups/g1/members/m3', { leftOn: '2026-10-19' }])
    })

    it('removes someone after a confirmation, then focuses the heading', async () => {
      call.mockImplementation(async () => {
        stored.members = stored.members.filter((row) => row.$id !== 'm3')
        return ok({})
      })
      renderAt('/groups/g1')
      const sam = await row('Sam')
      fireEvent.click(within(sam).getByRole('button', { name: 'Remove' }))
      expect(document.activeElement).toBe(within(sam).getByRole('button', { name: 'Cancel' }))
      fireEvent.click(within(sam).getByRole('button', { name: 'Remove' }))
      await waitFor(() => expect(screen.queryByText('Sam')).toBeNull())
      expect(sent()).toEqual(['groups', 'DELETE', '/groups/g1/members/m3', undefined])
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Flat 3', level: 1 }))
    })

    it('says to mark them as moved out when they can’t be removed', async () => {
      call.mockResolvedValue(
        refused(
          'VALIDATION_FAILED',
          "Members with transactions can't be removed. Set leftOn instead.",
        ),
      )
      renderAt('/groups/g1')
      const sam = await row('Sam')
      fireEvent.click(within(sam).getByRole('button', { name: 'Remove' }))
      fireEvent.click(within(sam).getByRole('button', { name: 'Remove' }))
      expect(await within(sam).findByRole('alert')).toHaveProperty(
        'textContent',
        'They have money or a schedule in this house. Mark them as moved out instead.',
      )
      fireEvent.click(within(sam).getByRole('button', { name: 'Cancel' }))
      expect(document.activeElement).toBe(within(sam).getByRole('button', { name: 'Remove' }))
    })
  })

  describe('leaving', () => {
    it('warns that the balance must be 0 and that it’s final, then leaves', async () => {
      call.mockResolvedValue(ok({}))
      const { router, queryClient } = renderAt('/groups/g1')
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      const leave = await screen.findByRole('region', { name: 'Leave this house' })
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      expect(within(leave).getByText(/balance here must be 0/)).toBeTruthy()
      expect(
        within(leave).getByText('Leaving is final: you can’t come back to this house.'),
      ).toBeTruthy()
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      await waitFor(() => expect(router.state.location.pathname).toBe('/groups'))
      expect(sent()).toEqual(['groups', 'POST', '/groups/g1/leave', undefined])
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
      // Back doesn't show the house as it was: its cached rows are gone.
      expect(queryClient.getQueryData(queryKeys.group('g1'))).toBeUndefined()
      expect(queryClient.getQueryData(queryKeys.members('g1'))).toBeUndefined()
      expect(queryClient.getQueryData(queryKeys.myMember('g1', 'p1'))).toBeUndefined()
    })

    it('shows a refusal in plain words', async () => {
      call.mockResolvedValue(
        refused('VALIDATION_FAILED', "Settle up first: your balance in this group isn't 0."),
      )
      renderAt('/groups/g1')
      const leave = await screen.findByRole('region', { name: 'Leave this house' })
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      expect(await within(leave).findByRole('alert')).toHaveProperty(
        'textContent',
        "Settle up first: your balance in this group isn't 0.",
      )
    })

    it('counts NOT_A_MEMBER on a retry as done, after a try whose answer was lost', async () => {
      // The first try went through, but its answer never came back.
      call.mockResolvedValueOnce(refused('INTERNAL', 'We couldn’t reach the server.'))
      const { router, queryClient } = renderAt('/groups/g1')
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      const leave = await screen.findByRole('region', { name: 'Leave this house' })
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      expect(await within(leave).findByText('We couldn’t reach the server.')).toBeTruthy()
      expect(router.state.location.pathname).toBe('/groups/g1')
      call.mockResolvedValueOnce(refused('NOT_A_MEMBER'))
      fireEvent.click(within(leave).getByRole('button', { name: 'Leave this house' }))
      await waitFor(() => expect(router.state.location.pathname).toBe('/groups'))
      // The house leaves the groups list.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
    })
  })

  describe('settings', () => {
    it('sends the name, split, monthly divide and auto-finalize', async () => {
      call.mockImplementation(async (_fn, _method, _path, body) => {
        const { name, statementCycle, settings } = body as Record<string, unknown>
        stored.group = {
          ...stored.group,
          name,
          statementCycle,
          settingsJson: JSON.stringify(settings),
        } as Groups
        return ok(stored.group)
      })
      const { queryClient } = renderAt('/groups/g1')
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      const settings = await screen.findByRole('region', { name: 'Settings' })
      const name = within(settings).getByLabelText('House name') as HTMLInputElement
      expect(name.value).toBe('Flat 3')
      fireEvent.change(name, { target: { value: ' Flat 4 ' } })
      fireEvent.change(within(settings).getByLabelText('Split bills'), {
        target: { value: 'equal' },
      })
      fireEvent.click(within(settings).getByLabelText('Close each month with a divide'))
      fireEvent.click(within(settings).getByRole('button', { name: 'Save' }))
      expect(await within(settings).findByText('Saved.')).toBeTruthy()
      expect(sent()).toEqual([
        'groups',
        'PATCH',
        '/groups/g1',
        {
          name: 'Flat 4',
          statementCycle: 'none',
          settings: { type: 'house', autoFinalize: false, defaultBillSplit: 'equal' },
        },
      ])
      expect(name.value).toBe('Flat 4')
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
    })

    it('sends only what changed, so another admin’s change isn’t undone', async () => {
      call.mockImplementation(async (_fn, _method, _path, body) => {
        const { name, settings } = body as { name?: string; settings?: unknown }
        stored.group = {
          ...stored.group,
          ...(name ? { name } : {}),
          ...(settings ? { settingsJson: JSON.stringify(settings) } : {}),
        } as Groups
        return ok(stored.group)
      })
      const { queryClient } = renderAt('/groups/g1')
      const settings = await screen.findByRole('region', { name: 'Settings' })
      // Another admin renames the house and splits bills equally meanwhile, and this page
      // reloads it.
      stored.group = {
        ...stored.group,
        name: 'Flat 9',
        settingsJson: JSON.stringify({
          type: 'house',
          autoFinalize: false,
          defaultBillSplit: 'equal',
        }),
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.group('g1') })
      expect(await screen.findByRole('heading', { name: 'Flat 9', level: 1 })).toBeTruthy()
      // Only auto-finalize changes here: the split sent is the one stored now, not the one this
      // form showed when it opened.
      fireEvent.click(within(settings).getByLabelText(/Finalize the divide automatically/))
      fireEvent.click(within(settings).getByRole('button', { name: 'Save' }))
      expect(await within(settings).findByText('Saved.')).toBeTruthy()
      expect(sent()).toEqual([
        'groups',
        'PATCH',
        '/groups/g1',
        { settings: { type: 'house', autoFinalize: true, defaultBillSplit: 'equal' } },
      ])
      // A rename sends the name alone.
      call.mockClear()
      fireEvent.change(within(settings).getByLabelText('House name'), {
        target: { value: 'Flat 4' },
      })
      fireEvent.click(within(settings).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalled())
      expect(sent()).toEqual(['groups', 'PATCH', '/groups/g1', { name: 'Flat 4' }])
    })

    it('sends nothing when nothing changed', async () => {
      renderAt('/groups/g1')
      const settings = await screen.findByRole('region', { name: 'Settings' })
      fireEvent.click(within(settings).getByRole('button', { name: 'Save' }))
      expect(await within(settings).findByText('Saved.')).toBeTruthy()
      expect(call).not.toHaveBeenCalled()
    })

    it('says the role changed when a save is refused for it, and focuses the heading', async () => {
      call.mockImplementation(async () => {
        // Another admin made Alex a member meanwhile.
        stored.members = stored.members.map((row) =>
          row.$id === 'm1' ? { ...row, role: 'member' } : row,
        )
        return refused('FORBIDDEN', "Your role in this group can't do this.")
      })
      renderAt('/groups/g1')
      const settings = await screen.findByRole('region', { name: 'Settings' })
      fireEvent.change(within(settings).getByLabelText('House name'), {
        target: { value: 'Flat 4' },
      })
      fireEvent.click(within(settings).getByRole('button', { name: 'Save' }))
      expect(await screen.findByText('Your role here is now Member.')).toBeTruthy()
      expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Flat 3', level: 1 }))
    })

    it('shows the server’s refusal, and no form for settings it can’t read', async () => {
      call.mockResolvedValue(refused('FORBIDDEN', "Your role in this group can't do this."))
      renderAt('/groups/g1')
      const settings = await screen.findByRole('region', { name: 'Settings' })
      fireEvent.change(within(settings).getByLabelText('House name'), {
        target: { value: 'Flat 4' },
      })
      fireEvent.click(within(settings).getByRole('button', { name: 'Save' }))
      expect(
        await within(settings).findByText("Your role in this group can't do this."),
      ).toBeTruthy()
      cleanup()
      seed('admin', { settingsJson: '{"type":"employer"}' })
      renderAt('/groups/g1')
      const unread = await screen.findByRole('region', { name: 'Settings' })
      expect(within(unread).getByRole('alert').textContent).toMatch(
        /couldn’t read this house’s settings/,
      )
      expect(within(unread).queryByRole('button')).toBeNull()
    })
  })
})
