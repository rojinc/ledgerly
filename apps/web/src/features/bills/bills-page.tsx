import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { type ReactNode, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroup } from '../groups/use-groups'
import { describeRepeat, fromRrule } from '../schedules/rrule'
import { formatDate } from '../statements/invoice-view'
import { isOverdue, monthsBefore } from './bill-values'
import { hasEnded, templateCents } from './recurring-values'
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
    isError: bootstrap.isError || group.isError,
  }
}

/** `/bills`: the personal group's bills, due, paid and recurring (#75). */
export function BillsPage() {
  const personal = usePersonalGroup()
  // A stopped bill's panel goes: focus lands here, and the status line reads out what happened.
  const heading = useRef<HTMLHeadingElement>(null)
  const [done, setDone] = useState('')
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          Bills
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/bills/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
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
        <BillLists
          group={personal.group}
          onStopped={(description) => {
            setDone(`Stopped ${description}. Bills already made stay.`)
            heading.current?.focus()
          }}
        />
      ) : personal.isError ? (
        <Message alert>We couldn’t load your bills. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

function BillLists({
  group,
  onStopped,
}: {
  group: Groups
  onStopped: (description: string) => void
}) {
  const today = localToday(group.timezone, new Date())
  const due = useDueBills(group.$id)
  const paid = usePaidBills(group.$id, monthsBefore(today, 3))
  const recurring = useRecurringBills(group.$id)
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
    </>
  )
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
              <span className="block text-sm text-muted-foreground">{when(bill)}</span>
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
  onStopped: (description: string) => void
}) {
  const stop = useStopRecurringBill(schedule.$id)
  const [confirming, setConfirming] = useState(false)
  const stopButton = useRef<HTMLButtonElement>(null)
  const repeat = fromRrule(schedule.rrule)
  const cents = templateCents(schedule)
  const ended = hasEnded(schedule, today)
  const details = [
    repeat ? describeRepeat(repeat) : undefined,
    cents === undefined ? undefined : money(cents),
    schedule.autoPost ? 'Autopay' : undefined,
    ended ? 'Ended' : schedule.endsOn ? `Last due ${formatDate(schedule.endsOn)}` : undefined,
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
            onClick={() => setConfirming(true)}
            aria-label={`Stop ${schedule.description}`}
          >
            Stop
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <p className="text-sm">
            Stop {schedule.description} from today? No more bills are made after today. Bills
            already made stay, so you can still pay or skip them.
          </p>
          {stop.isError && <Message alert>{stop.error.message}</Message>}
          <div className="flex flex-wrap gap-2">
            <Button
              aria-disabled={stop.isPending}
              onClick={() => {
                if (stop.isPending) return
                stop.mutate(
                  { endsOn: today },
                  {
                    onSuccess: () => {
                      setConfirming(false)
                      onStopped(schedule.description)
                    },
                  },
                )
              }}
            >
              {stop.isPending ? 'Stopping…' : 'Stop it'}
            </Button>
            <Button
              variant="ghost"
              aria-disabled={stop.isPending}
              onClick={() => {
                if (stop.isPending) return
                setConfirming(false)
                // The Stop button comes back: focus goes back to it.
                requestAnimationFrame(() => stopButton.current?.focus())
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
