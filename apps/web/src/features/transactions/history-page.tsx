import { CATEGORIES } from '@ledgerly/core/constants/categories'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
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

// The kinds an employer group has (ledger.md#transaction-kinds).
const EMPLOYER_KINDS: Transactions['kind'][] = ['shift', 'expense', 'payment', 'adjustment']

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
 * `/transactions?groupId=`: an employer group's balance and history, filtered by kind, dates
 * and category (#31). Archived groups stay readable.
 */
export function HistoryPage() {
  const groups = useGroups()
  const [params, setParams] = useSearchParams()
  const employers = groups.data?.filter((group) => group.type === 'employer')
  const group = employers?.find((g) => g.$id === params.get('groupId')) ?? employers?.[0]

  // The filters live in the URL, so a refresh or a shared link keeps them.
  // A hand-edited link with an unknown kind or category is ignored, not sent to Appwrite.
  const kind = EMPLOYER_KINDS.find((k) => k === params.get('kind'))
  const category = CATEGORIES.find((c) => c === params.get('category'))
  const filters: HistoryFilters = {
    ...(kind ? { kind } : {}),
    ...(category ? { category } : {}),
    ...(params.get('from') ? { from: params.get('from') as string } : {}),
    ...(params.get('to') ? { to: params.get('to') as string } : {}),
  }
  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value === '') next.delete(name)
    else next.set(name, value)
    setParams(next, { replace: true })
  }

  let content: ReactNode
  if (!employers) {
    content =
      groups.isError && !groups.data ? (
        <Message alert>We couldn’t load your groups. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (!group) {
    content = (
      <Message>
        Add an employer first:{' '}
        <Link to="/groups/new-employer" className="underline underline-offset-4">
          New employer
        </Link>
      </Message>
    )
  } else {
    content = (
      <>
        {employers.length > 1 && (
          <SelectField
            id="historyGroup"
            label="Employer"
            value={group.$id}
            onChange={(event) => setParam('groupId', event.target.value)}
          >
            {employers.map((g) => (
              <option key={g.$id} value={g.$id}>
                {g.name}
                {g.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </SelectField>
        )}
        <GroupSummary group={group} />
        <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <legend className="sr-only">Filters</legend>
          <SelectField
            id="filterKind"
            label="Kind"
            value={filters.kind ?? ''}
            onChange={(event) => setParam('kind', event.target.value)}
          >
            <option value="">All</option>
            {EMPLOYER_KINDS.map((kind) => (
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
        <History group={group} filters={filters} />
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
  // permissions.md: admins and members add; a viewer (an employer who joined) only reads.
  const canAdd =
    !group.archivedAt && (member.data?.role === 'admin' || member.data?.role === 'member')

  let balance: ReactNode
  // Only once it's known whose side to word it from, and who the other person is.
  if (balances.data && personId !== '' && other !== undefined) {
    const net = balances.data.people.find((p) => p.personId === personId)?.netCents ?? 0
    const amount = formatMoney(Math.abs(net), group.currency)
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
        <p className="text-xl font-semibold" aria-live="polite">
          {balance}
        </p>
      </div>
      {group.archivedAt && <Message>{ARCHIVED_NOTICE}</Message>}
      {canAdd && (
        <Link
          to={`/transactions/new?groupId=${group.$id}`}
          className="inline-flex h-10 items-center self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Add expense or payment
        </Link>
      )}
    </section>
  )
}

function History({ group, filters }: { group: Groups; filters: HistoryFilters }) {
  const history = useHistory(group.$id, filters)
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
        <p className="text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={row.$id}>
              <Link
                to={`/transactions/${row.$id}`}
                className="flex items-center justify-between gap-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="min-w-0">
                  <span
                    className={`block truncate font-medium ${row.status === 'void' ? 'line-through' : ''}`}
                  >
                    {row.description}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {row.date} · {KIND_LABEL[row.kind]} · {STATUS_LABEL[row.status]}
                  </span>
                </span>
                {row.status !== 'running' && (
                  <span className="shrink-0 tabular-nums">
                    {formatMoney(row.totalCents, group.currency)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {history.isFetchNextPageError && <Message alert>We couldn’t load more. Try again.</Message>}
      {history.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={history.isFetchingNextPage}
          onClick={() => history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </section>
  )
}
