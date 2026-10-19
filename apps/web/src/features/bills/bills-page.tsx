import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroup, useMyMember } from '../groups/use-groups'
import { describeRepeat, fromRrule } from '../schedules/rrule'
import { hasEnded } from '../schedules/schedules-page'
import { formatDate } from '../statements/invoice-view'
import { isOverdue, monthsBefore, storedExtras } from './bill-values'
import { lastDue, templateCents } from './recurring-values'
import { useDueBills, usePaidBills, useRecurringBills, useStopRecurringBill } from './use-bills'

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

/** `/bills`: the personal group's bills, due, paid and recurring (#75), or with `?groupId=` a house's (#44). */
export function BillsPage() {
  const groupId = useSearchParams()[0].get('groupId')
  return groupId ? <HouseBillsPage groupId={groupId} /> : <PersonalBillsPage />
}

function PersonalBillsPage() {
  const personal = usePersonalGroup()
  // A stopped bill's panel goes: focus lands here, and the status line reads out what happened.
  const heading = useRef<HTMLHeadingElement>(null)
  const [done, setDone] = useState('')
  // Back from saving a recurring bill: its form, and the button that sent it, are gone.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (!(location.state as { saved?: boolean } | null)?.saved) return
    heading.current?.focus()
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          Bills
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/bills/new" className={BUTTON_LINK}>
            New bill
          </Link>
          <Link
            to="/bills/recurring/new"
            className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            New recurring bill
          </Link>
        </div>
      </div>
      {/* Mounted from the start, so a change is read out. */}
      <p role="status" className="text-sm empty:hidden">
        {done}
      </p>
      {personal.group ? (
        <>
          <BillLists group={personal.group} />
          <RecurringBills
            group={personal.group}
            onStopped={(message) => {
              setDone(message)
              heading.current?.focus()
            }}
          />
        </>
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

/** A group's due and paid bills. */
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

/** The personal group's recurring bills (#75), told what was stopped. */
function RecurringBills({
  group,
  onStopped,
}: {
  group: Groups
  onStopped: (message: string) => void
}) {
  const today = localToday(group.timezone, new Date())
  const money = (cents: number) => formatMoney(cents, group.currency)
  const recurring = useRecurringBills(group.$id)
  return (
    <section aria-labelledby="recurring-bills" className="flex flex-col gap-2">
      <h2 id="recurring-bills" className="font-medium">
        Recurring
      </h2>
      {recurring.data ? (
        recurring.data.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {recurring.data.map((schedule) => (
              <RecurringBill
                key={schedule.$id}
                schedule={schedule}
                today={today}
                money={money}
                onStopped={onStopped}
              />
            ))}
          </ul>
        )
      ) : recurring.isError ? (
        <Message alert>We couldn’t load the recurring bills.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </section>
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

function RecurringBill({
  schedule,
  today,
  money,
  onStopped,
}: {
  schedule: Schedules
  today: LocalDate
  money: (cents: number) => string
  onStopped: (message: string) => void
}) {
  const stop = useStopRecurringBill(schedule)
  const [confirming, setConfirming] = useState(false)
  const stopButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const repeat = fromRrule(schedule.rrule)
  const cents = templateCents(schedule)
  const ended = hasEnded(schedule, today)
  // The rule's own last date is in its words already; a stop's earlier end date isn't.
  const last =
    schedule.endsOn && lastDue(schedule) === schedule.endsOn ? schedule.endsOn : undefined
  // Not started: Stop removes it, except a first bill already paid early, which ends it there.
  const notStarted = today < schedule.startsOn
  const details = [
    repeat ? describeRepeat(repeat, formatDate) : undefined,
    cents === undefined ? undefined : money(cents),
    schedule.autoPost ? 'Autopay' : undefined,
    notStarted ? `Starts ${formatDate(schedule.startsOn)}` : undefined,
    ended ? 'Ended' : last ? `Last due ${formatDate(last)}` : undefined,
  ].filter(Boolean)
  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-medium break-words">{schedule.description}</span>
          <span className="block text-sm text-muted-foreground">{details.join(' · ')}</span>
        </span>
        {/* Stopping sets its end date, so one already set has nothing to stop. */}
        {!ended && !schedule.endsOn && !confirming && (
          <Button
            ref={stopButton}
            variant="outline"
            onClick={() => {
              // The button goes as the question opens: focus moves to its safe answer, Cancel.
              flushSync(() => setConfirming(true))
              cancelButton.current?.focus()
            }}
            aria-label={`Stop ${schedule.description}`}
          >
            Stop
          </Button>
        )}
      </div>
      {confirming && (
        // A fieldset is a group: named by the question, which is read out with Cancel.
        <fieldset
          aria-labelledby={`stop-${schedule.$id}`}
          className="m-0 flex min-w-0 flex-col gap-2 rounded-md border border-border p-3"
        >
          <p id={`stop-${schedule.$id}`} className="text-sm">
            {notStarted
              ? `Remove ${schedule.description}? It hasn’t started yet, so its bills are removed, except any you’ve already paid.`
              : `Stop ${schedule.description} from today? No more bills are made after today. Bills already made stay, so you can still pay or skip them.`}
          </p>
          {stop.isError && <Message alert>{stop.error.message}</Message>}
          <div className="flex flex-wrap gap-2">
            <Button
              aria-disabled={stop.isPending}
              onClick={() => {
                if (stop.isPending) return
                stop.mutate(today, {
                  // Undefined when it was removed; a schedule when it was ended.
                  onSuccess: (stopped) => {
                    setConfirming(false)
                    onStopped(
                      stopped
                        ? `Stopped ${schedule.description}. Bills already made stay.`
                        : `Removed ${schedule.description}.`,
                    )
                  },
                })
              }}
            >
              {stop.isPending ? 'Stopping…' : notStarted ? 'Remove it' : 'Stop it'}
            </Button>
            <Button
              ref={cancelButton}
              variant="ghost"
              aria-disabled={stop.isPending}
              onClick={() => {
                if (stop.isPending) return
                setConfirming(false)
                // A refusal shown in the question goes with it.
                stop.reset()
                // The Stop button comes back: focus goes back to it.
                requestAnimationFrame(() => stopButton.current?.focus())
              }}
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      )}
    </li>
  )
}
