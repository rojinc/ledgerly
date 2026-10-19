import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroup, useMyMember } from '../groups/use-groups'
import { formatDate } from '../statements/invoice-view'
import { isOverdue, monthsBefore, storedExtras } from './bill-values'
import { useDueBills, usePaidBills } from './use-bills'

export function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={alert ? 'text-destructive' : 'text-muted-foreground'}
    >
      {children}
    </p>
  )
}

/** The user's personal group, where their own bills live (bootstrap's `personalGroupId`). */
export function usePersonalGroup() {
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const group = useGroup(bootstrap.data?.personalGroupId ?? '')
  return {
    group: bootstrap.data ? group.data : undefined,
    personId: bootstrap.data?.personId ?? '',
    isError: bootstrap.isError || group.isError,
  }
}

const BUTTON_LINK =
  'inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

/** `/bills`: the personal group's bills (#75), or with `?groupId=` a house's (#44). */
export function BillsPage() {
  const groupId = useSearchParams()[0].get('groupId')
  return groupId ? <HouseBillsPage groupId={groupId} /> : <PersonalBillsPage />
}

function PersonalBillsPage() {
  const personal = usePersonalGroup()
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Bills</h1>
        <Link to="/bills/new" className={BUTTON_LINK}>
          New bill
        </Link>
      </div>
      {personal.group ? (
        <BillLists group={personal.group} />
      ) : personal.isError ? (
        <Message alert>We couldn’t load your bills. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

/**
 * The house the link names, if it's one the user can read, with the caller's role in it. Undefined
 * while loading; null for a group that isn't a readable house.
 */
export function useHouse(groupId: string) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const group = useGroup(groupId)
  const me = useMyMember(groupId, personId)
  const house = group.data?.type === 'house' ? group.data : null
  return {
    house: group.isError ? null : group.data ? house : undefined,
    personId,
    // permissions.md: admins and members add bills; nobody adds to an archived house.
    canAdd:
      Boolean(house && !house.archivedAt) &&
      (me.data?.role === 'admin' || me.data?.role === 'member'),
    // The caller's member row was read, or can't be: until then `canAdd` isn't settled.
    roleKnown: me.data !== undefined || me.isError,
  }
}

function HouseBillsPage({ groupId }: { groupId: string }) {
  const { house, canAdd } = useHouse(groupId)
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold break-words">
          {house ? `Bills · ${house.name}` : 'Bills'}
        </h1>
        {canAdd && (
          <Link to={`/bills/new?groupId=${groupId}`} className={BUTTON_LINK}>
            New bill
          </Link>
        )}
      </div>
      {house ? (
        <BillLists group={house} />
      ) : house === null ? (
        <Message alert>We couldn’t find that house.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

function BillLists({ group }: { group: Groups }) {
  const today = localToday(group.timezone, new Date())
  const due = useDueBills(group.$id)
  const paid = usePaidBills(group.$id, monthsBefore(today, 3))
  const money = (cents: number) => formatMoney(cents, group.currency)
  return (
    <>
      <section aria-labelledby="due-bills" className="flex flex-col gap-2">
        <h2 id="due-bills" className="font-medium">
          Due
        </h2>
        {due.data ? (
          due.data.length === 0 ? (
            <p className="text-muted-foreground">Nothing due.</p>
          ) : (
            <BillList
              bills={due.data}
              money={money}
              when={(bill) => {
                const dueOn = bill.dueOn ?? bill.date
                return isOverdue(dueOn, today)
                  ? `Overdue · was due ${formatDate(dueOn)}`
                  : `Due ${formatDate(dueOn)}`
              }}
            />
          )
        ) : due.isError ? (
          <Message alert>We couldn’t load the bills that are due.</Message>
        ) : (
          <Message>Loading…</Message>
        )}
      </section>
      <section aria-labelledby="paid-bills" className="flex flex-col gap-2">
        <h2 id="paid-bills" className="font-medium">
          Paid in the last 3 months
        </h2>
        {paid.data ? (
          paid.data.length === 0 ? (
            <p className="text-muted-foreground">None yet.</p>
          ) : (
            <BillList
              bills={paid.data}
              money={money}
              when={(bill) => `Paid ${formatDate(bill.date)}`}
            />
          )
        ) : paid.isError ? (
          <Message alert>We couldn’t load the paid bills.</Message>
        ) : (
          <Message>Loading…</Message>
        )}
      </section>
    </>
  )
}

/** ` · for 1 Jul 2026 – 30 Sep 2026`, for a bill with a billing period. */
function periodText(bill: Pick<Transactions, 'inputJson'>): string {
  const { periodStart, periodEnd } = storedExtras(bill.inputJson).period ?? {}
  return periodStart && periodEnd
    ? ` · for ${formatDate(periodStart)} – ${formatDate(periodEnd)}`
    : ''
}

function BillList({
  bills,
  money,
  when,
}: {
  bills: Transactions[]
  money: (cents: number) => string
  when: (bill: Transactions) => string
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {bills.map((bill) => (
        <li key={bill.$id}>
          <Link
            to={`/bills/${bill.$id}`}
            className="flex items-center justify-between gap-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="min-w-0">
              <span className="block font-medium break-words">{bill.description}</span>
              <span className="block text-sm text-muted-foreground">
                {when(bill)}
                {periodText(bill)}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">{money(bill.totalCents)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
