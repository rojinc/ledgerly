import { CATEGORIES } from '@ledgerly/core/constants/categories'
import { TRANSACTION_KINDS } from '@ledgerly/core/constants/domain'
import { isLocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { KINDS_BY_GROUP } from '@ledgerly/core/ledger/build-shares'
import { formatMoney, formatNet } from '@ledgerly/core/money/format'
import { type ReactNode, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { cn } from '../../lib/utils'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { GroupName, useSortedByName } from '../groups/use-group-name'
import { useBalances, useGroups, useMyMember } from '../groups/use-groups'
import { type HistoryFilters, useHistory, useMembers } from './use-transactions'

export const KIND_LABEL: Record<Transactions['kind'], string> = {
  expense: 'Expense',
  bill: 'Bill',
  shift: 'Shift',
  payment: 'Payment',
  loan: 'Loan',
  income: 'Income',
  adjustment: 'Adjustment',
}

export const STATUS_LABEL: Record<Transactions['status'], string> = {
  scheduled: 'Scheduled',
  due: 'Due',
  running: 'Running',
  posted: 'Posted',
  void: 'Void',
}

// Where each group type adds entries: an employer's link is in its summary, and a pair records
// them on its own page.
const ADD: Partial<Record<Groups['type'], { label: string; path: string }>> = {
  house: { label: 'Add expense', path: '/transactions/new?groupId=' },
  pair: { label: 'Record money lent or borrowed', path: '/people/' },
  personal: { label: 'Add income or expense', path: '/transactions/new?groupId=' },
}

const ADD_LINK =
  'inline-flex h-10 items-center self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={alert ? 'text-destructive' : 'text-muted-foreground'}
    >
      {children}
    </p>
  )
}

/**
 * `/transactions?groupId=`: every group's history (All groups, F-71), or one group's: an
 * employer's with its balance (#31), any other with its Add link. Filtered by kind, category,
 * dates and description, and in one group by person. Archived groups stay readable.
 */
export function HistoryPage() {
  const groups = useGroups()
  const sorted = useSortedByName(groups.data ?? [])
  const [params, setParams] = useSearchParams()
  // No ?groupId=, or one that isn't the user's: All groups.
  const group = sorted.find((g) => g.$id === params.get('groupId'))
  const members = useMembers(group?.$id ?? '')
  // The kinds the picked group's type allows (ledger.md#transaction-kinds), or every kind.
  const kinds = group ? KINDS_BY_GROUP[group.type] : TRANSACTION_KINDS

  // The filters live in the URL, so a refresh or a shared link keeps them.
  // A hand-edited link with an unknown kind or category is ignored, not sent to Appwrite.
  const kind = kinds.find((k) => k === params.get('kind'))
  const category = CATEGORIES.find((c) => c === params.get('category'))
  const q = params.get('q')?.trim() ?? ''
  // A person is one of the group's members: none under All groups, and none in the personal
  // group, whose owner is its only member.
  const byPerson = group !== undefined && group.type !== 'personal'
  const person = byPerson
    ? members.data?.find((m) => m.personId === params.get('person'))
    : undefined
  const filters: HistoryFilters = {
    ...(kind ? { kind } : {}),
    ...(category ? { category } : {}),
    // A hand-edited link with a date that isn't one is ignored too.
    ...(isLocalDate(params.get('from')) ? { from: params.get('from') as string } : {}),
    ...(isLocalDate(params.get('to')) ? { to: params.get('to') as string } : {}),
    ...(q ? { q } : {}),
    ...(person ? { personId: person.personId } : {}),
  }
  // Until the members are known, the link's person can't be checked: wait, rather than list
  // everyone's rows first.
  const checkingPerson = Boolean(byPerson && params.get('person') && members.isPending)
  // What's typed, spaces and all; the URL keeps it trimmed. A link that changes ?q= wins.
  const [typed, setTyped] = useState(q)
  const search = typed.trim() === q ? typed : q
  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value === '') next.delete(name)
    else next.set(name, value)
    setParams(next, { replace: true })
  }

  // A person is one group's, and a kind may not be the next group's, so neither carries over.
  function pickGroup(id: string) {
    const next = new URLSearchParams(params)
    if (id === '') next.delete('groupId')
    else next.set('groupId', id)
    next.delete('person')
    const picked = sorted.find((g) => g.$id === id)
    const allowed = picked ? KINDS_BY_GROUP[picked.type] : TRANSACTION_KINDS
    if (!allowed.some((k) => k === next.get('kind'))) next.delete('kind')
    setParams(next, { replace: true })
  }

  let content: ReactNode
  if (!groups.data) {
    content = groups.isError ? (
      <Message alert>We couldn’t load your groups. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  } else if (sorted.length === 0) {
    content = (
      <Message>
        You aren’t in any group yet. Start one from{' '}
        <Link to="/groups" className="underline underline-offset-4">
          Groups
        </Link>
        .
      </Message>
    )
  } else {
    content = (
      <>
        <SelectField
          id="historyGroup"
          label="Group"
          value={group?.$id ?? ''}
          onChange={(event) => pickGroup(event.target.value)}
        >
          <option value="">All groups</option>
          {sorted.map((g) => (
            <option key={g.$id} value={g.$id}>
              <GroupName group={g} />
              {g.archivedAt ? ' (archived)' : ''}
            </option>
          ))}
        </SelectField>
        {group &&
          (group.type === 'employer' ? <GroupSummary group={group} /> : <AddLink group={group} />)}
        <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <legend className="sr-only">Filters</legend>
          <div className="col-span-2 sm:col-span-4">
            <TextField
              id="filterSearch"
              type="search"
              label="Search descriptions"
              value={search}
              onChange={(event) => {
                setTyped(event.target.value)
                setParam('q', event.target.value.trim())
              }}
            />
          </div>
          {byPerson && (
            <div className="col-span-2 sm:col-span-1">
              <SelectField
                id="filterPerson"
                label="Person"
                value={person?.personId ?? ''}
                onChange={(event) => setParam('person', event.target.value)}
              >
                <option value="">Everyone</option>
                {[...(members.data ?? [])]
                  .sort((a, b) => a.displayName.localeCompare(b.displayName))
                  .map((member) => (
                    <option key={member.personId} value={member.personId}>
                      {member.displayName}
                    </option>
                  ))}
              </SelectField>
            </div>
          )}
          <SelectField
            id="filterKind"
            label="Kind"
            value={filters.kind ?? ''}
            onChange={(event) => setParam('kind', event.target.value)}
          >
            <option value="">All</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="filterCategory"
            label="Category"
            value={filters.category ?? ''}
            onChange={(event) => setParam('category', event.target.value)}
          >
            <option value="">All</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category[0]?.toUpperCase()}
                {category.slice(1)}
              </option>
            ))}
          </SelectField>
          <TextField
            id="filterFrom"
            type="date"
            label="From"
            value={filters.from ?? ''}
            onChange={(event) => setParam('from', event.target.value)}
          />
          <TextField
            id="filterTo"
            type="date"
            label="To"
            value={filters.to ?? ''}
            onChange={(event) => setParam('to', event.target.value)}
          />
        </fieldset>
        {checkingPerson ? (
          <Message>Loading…</Message>
        ) : (
          <History group={group} groups={groups.data} filters={filters} />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">History</h1>
      {content}
    </div>
  )
}

/** The balance, from the viewer's side, and the add link for those who can write. */
function GroupSummary({ group }: { group: Groups }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const personId = bootstrap.data?.personId ?? ''
  const member = useMyMember(group.$id, personId)
  const members = useMembers(group.$id)
  const balances = useBalances(group.$id)
  const other = members.data?.find((m) => m.personId !== personId)?.displayName
  // permissions.md: admins and members add; a viewer (an employer who joined) only reads. The
  // entry form speaks as the worker, so only the group's owner gets it (as on that page).
  const canAdd =
    !group.archivedAt &&
    group.ownerPersonId === personId &&
    (member.data?.role === 'admin' || member.data?.role === 'member')

  let balance: ReactNode
  // Only once it's known whose side to word it from, and who the other person is.
  if (balances.data && personId !== '' && other !== undefined) {
    const net = balances.data.people.find((p) => p.personId === personId)?.netCents ?? 0
    const amount = formatNet(Math.abs(net), group.currency)
    balance =
      net > 0
        ? `${other} owes you ${amount}`
        : net < 0
          ? `You owe ${other} ${amount}`
          : 'All square'
  } else {
    balance =
      balances.isError || bootstrap.isError || members.isError
        ? 'Balance not available right now.'
        : 'Loading…'
  }
  return (
    <section aria-labelledby="balance-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-md border border-border p-4">
        <h2 id="balance-heading" className="text-sm text-muted-foreground">
          Balance with {group.name}
        </h2>
        <p className="text-xl font-semibold break-words" aria-live="polite">
          {balance}
        </p>
      </div>
      {group.archivedAt && <Message>{ARCHIVED_NOTICE}</Message>}
      {canAdd && (
        <Link to={`/transactions/new?groupId=${group.$id}`} className={ADD_LINK}>
          Add expense or payment
        </Link>
      )}
      <Link
        to={`/groups/${group.$id}/statements`}
        className="self-start text-sm underline underline-offset-4"
      >
        Invoices
      </Link>
    </section>
  )
}

/**
 * A house's, a pair's or the personal group's add link, for its admins and members
 * (permissions.md). An archived group takes no entries.
 */
function AddLink({ group }: { group: Groups }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const role = useMyMember(group.$id, personId).data?.role
  const add = ADD[group.type]
  if (group.archivedAt) return <Message>{ARCHIVED_NOTICE}</Message>
  if (!add || (role !== 'admin' && role !== 'member')) return null
  return (
    <Link to={`${add.path}${group.$id}`} className={ADD_LINK}>
      {add.label}
    </Link>
  )
}

/** One group's history, or with no `group` every group's, each row naming its group. */
function History({
  group,
  groups,
  filters,
}: {
  group?: Groups
  /** Every group the user is in. */
  groups: Groups[]
  filters: HistoryFilters
}) {
  const history = useHistory(group?.$id ?? groups.map((g) => g.$id), filters)
  const byId = new Map(groups.map((g) => [g.$id, g]))
  if (!history.data) {
    return history.isError ? (
      <div className="flex flex-col items-start gap-3">
        <Message alert>We couldn’t load the history.</Message>
        <Button variant="outline" onClick={() => history.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <Message>Loading…</Message>
    )
  }
  const rows = history.data.pages.flat()
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="font-medium">
        Transactions
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {/* A person's page of shares can match none of the other filters, with more after it. */}
          {history.hasNextPage
            ? 'None of the latest entries match. Load more to look further back.'
            : 'Nothing here yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => {
            // The query reads only these groups.
            const rowGroup = byId.get(row.groupId) as Groups
            return (
              <li key={row.$id}>
                {/* As the house History's rows: the details run under the amount too (#502). */}
                <Link
                  to={`/transactions/${row.$id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  {/* A running timer has no amount, so its description takes the whole row. It and the
                      group's name wrap on a phone, so nothing is cut off at 320 px (#539). */}
                  <span
                    className={cn(
                      'min-w-0 break-words md:truncate font-medium',
                      row.status === 'running' && 'col-span-2',
                      row.status === 'void' && 'line-through',
                    )}
                  >
                    {row.description}
                  </span>
                  <span className="col-span-2 text-sm text-muted-foreground">
                    {row.date} · {KIND_LABEL[row.kind]} · {STATUS_LABEL[row.status]}
                  </span>
                  {/* A line of its own, so the status still fits at 375 px. */}
                  {!group && (
                    <span className="col-span-2 break-words md:truncate text-sm text-muted-foreground">
                      <GroupName group={rowGroup} />
                    </span>
                  )}
                  {row.status !== 'running' && (
                    <span className="col-start-2 row-start-1 tabular-nums">
                      {formatMoney(row.totalCents, rowGroup.currency)}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {history.isFetchNextPageError && <Message alert>We couldn’t load more. Try again.</Message>}
      {history.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          aria-disabled={history.isFetchingNextPage}
          onClick={() => {
            if (!history.isFetchingNextPage) void history.fetchNextPage()
          }}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </section>
  )
}
