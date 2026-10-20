import { addDays, isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday, periodEndClosedAt } from '@ledgerly/core/dates/time-zone'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { formatNet } from '@ledgerly/core/money/format'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useSwap } from '../../lib/use-swap'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroup, useMyMember } from '../groups/use-groups'
import { closingText } from './divide-view'
import { readSnapshot } from './invoice-sections'
import { formatDate } from './invoice-view'
import {
  UnfinishedDraft,
  useCloseStatement,
  usePreviewStatement,
  useStatements,
} from './use-statements'

export const STATUS_LABEL: Record<Statements['status'], string> = {
  draft: 'Draft',
  finalizing: 'Finalizing',
  final: 'Final',
  void: 'Void',
}

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
 * `/groups/{groupId}/statements`: a group's invoices (#32), or a house's divides (#166), latest
 * period first.
 */
export function StatementsPage() {
  const groupId = useParams().groupId ?? ''
  const group = useGroup(groupId)
  const statements = useStatements(groupId)
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const member = useMyMember(groupId, personId)
  const house = group.data?.type === 'house'
  // Only employer and house groups have statements (statements.md).
  const kind = group.data?.type === 'employer' || house
  // As on a statement's page: an admin, in a group that isn't archived.
  const open = kind && member.data?.role === 'admin' && !group.data?.archivedAt
  // A discard comes back here (#166): say so in a status region that was already there, so it's
  // read out, and focus the heading. The state is cleared, so a reload doesn't say it again.
  const location = useLocation()
  const navigate = useNavigate()
  const heading = useRef<HTMLHeadingElement>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    const discarded = (location.state as { discarded?: string } | null)?.discarded
    if (!discarded) return
    setNote(`The draft for ${discarded} was discarded.`)
    heading.current?.focus()
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  let content: ReactNode
  if (!statements.data || !group.data) {
    content =
      (statements.isError && !statements.data) || (group.isError && !group.data) ? (
        <div className="flex flex-col items-start gap-3">
          <Message alert>We couldn’t load the {house ? 'statements' : 'invoices'}.</Message>
          <Button
            variant="outline"
            onClick={() => {
              void statements.refetch()
              void group.refetch()
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (statements.data.length === 0) {
    content = (
      <p className="text-muted-foreground">
        {house ? 'No statements yet.' : 'No invoices yet.'}
        {/* With no cycle, only an admin's close makes one (statements.md#6). */}
        {group.data.statementCycle !== 'none' &&
          (house
            ? ' The first divide is drafted when this house’s period ends.'
            : ' The first draft is made when this group’s period ends.')}
      </p>
    )
  } else {
    const currency = group.data.currency
    content = (
      <ul className="divide-y divide-border rounded-md border border-border">
        {statements.data.map((statement) => {
          const balance = readSnapshot(statement.snapshotJson)?.invoice?.balanceDueCents
          return (
            <li key={statement.$id}>
              <Link
                to={`/groups/${groupId}/statements/${statement.$id}`}
                className="flex flex-wrap items-center justify-between gap-x-3 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="min-w-0">
                  <span
                    className={`block font-medium ${statement.status === 'void' ? 'line-through' : ''}`}
                  >
                    {statement.type === 'divide'
                      ? statement.status === 'draft' || statement.status === 'finalizing'
                        ? 'Draft divide'
                        : 'Divide'
                      : (statement.displayNumber ?? 'Draft invoice')}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {formatDate(statement.periodStart)} – {formatDate(statement.periodEnd)} ·{' '}
                    {STATUS_LABEL[statement.status]}
                    {statement.sentAt ? ' · Sent' : ''}
                  </span>
                </span>
                {balance !== undefined && (
                  <span className="text-sm tabular-nums">{formatNet(balance, currency)}</span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="min-w-0 text-2xl font-semibold break-words outline-none"
      >
        {house ? 'Statements' : 'Invoices'}
        {group.data ? ` for ${group.data.name}` : ''}
      </h1>
      <p role="status" className="text-muted-foreground empty:hidden">
        {note}
      </p>
      {kind && <CurrentPeriod groupId={groupId} />}
      {/* Once the list is in: a close can't end before the day after its latest statement. */}
      {open && group.data && statements.data && (
        <ClosePeriod group={group.data} statements={statements.data} />
      )}
      {content}
    </div>
  )
}

/**
 * What the next statement would hold if it were closed today, for everyone in the group
 * (statements.md#6): its period, and the balance due or each person's closing. No PDF.
 */
function CurrentPeriod({ groupId }: { groupId: string }) {
  const preview = usePreviewStatement(groupId)
  const snapshot = preview.data?.snapshot
  let body: ReactNode
  if (!snapshot) {
    body = preview.isError ? (
      <div className="flex flex-col items-start gap-3">
        <Message alert>We couldn’t work out the current period. {preview.error.message}</Message>
        <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <Message>Loading…</Message>
    )
  } else {
    // Closings and the balance due are worked out, so they can pass the amount cap.
    const money = (cents: number) => formatNet(cents, snapshot.group.currency)
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          {formatDate(snapshot.period.start)} – {formatDate(snapshot.period.end)}
        </p>
        {snapshot.invoice ? (
          <p className="flex flex-wrap justify-between gap-x-3">
            <span>Balance due</span>
            <span className="tabular-nums">{money(snapshot.invoice.balanceDueCents)}</span>
          </p>
        ) : snapshot.people.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {snapshot.people.map((person) => (
              <li key={person.personId} className="break-words">
                {person.name} {closingText(person.closingCents, money)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">Nothing in it yet.</p>
        )}
      </>
    )
  }
  return (
    <section
      aria-labelledby="current-period-heading"
      className="flex flex-col gap-2 rounded-md border border-border p-4"
    >
      <h2 id="current-period-heading" className="font-medium">
        Current period so far
      </h2>
      {body}
    </section>
  )
}

/** An admin drafts the next statement now, up to a day they pick (statements.md#6). */
function ClosePeriod({ group, statements }: { group: Groups; statements: Statements[] }) {
  const swap = useSwap()
  if (!swap.opened) {
    return (
      <Button ref={swap.trigger} variant="outline" className="self-start" onClick={swap.open}>
        Close period now…
      </Button>
    )
  }
  return (
    <CloseForm group={group} statements={statements} heading={swap.heading} onCancel={swap.close} />
  )
}

function CloseForm({
  group,
  statements,
  heading,
  onCancel,
}: {
  group: Groups
  statements: Statements[]
  heading: RefObject<HTMLHeadingElement | null>
  onCancel: () => void
}) {
  const close = useCloseStatement(group.$id)
  const navigate = useNavigate()
  // statements.md#6: up to today, or the end of the period the job drafts next if that's earlier
  // (in the hours after a period ends, before the job has drafted it).
  const [latest] = useState(() => {
    const today = localToday(group.timezone, new Date())
    const due = group.nextCloseAt && periodEndClosedAt(group.nextCloseAt, group.timezone)
    return due && due < today ? due : today
  })
  // The next statement starts the day after the latest one, void ones included.
  const ends = statements.map((row) => row.periodEnd as LocalDate)
  const first =
    ends.length > 0
      ? addDays(
          ends.reduce((a, b) => (a > b ? a : b)),
          1,
        )
      : undefined
  const [periodEnd, setPeriodEnd] = useState<string>(latest)
  const [error, setError] = useState('')
  // Set when the day picked is before that start.
  const tooEarly = first && isLocalDate(periodEnd) && periodEnd < first ? first : undefined
  const valid = isLocalDate(periodEnd) && periodEnd <= latest && !tooEarly
  const preview = usePreviewStatement(group.$id, periodEnd, valid)
  // Where a close ending on that day would start.
  const start = preview.data?.snapshot.period.start
  let covers = ''
  if (tooEarly) {
    covers = `The next one starts on ${formatDate(tooEarly)}, so pick that day or a later one.`
  } else if (valid) {
    const end = formatDate(periodEnd)
    covers = preview.isError
      ? `We couldn’t work out what it would cover. ${preview.error.message}`
      : !start
        ? 'Working out what it covers…'
        : `Covers ${formatDate(start)} – ${end}. Entries after ${end} go on the next one.`
  }
  return (
    <form
      noValidate
      aria-labelledby="close-heading"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (close.isPending) return
        const problem =
          periodEnd === ''
            ? 'Required'
            : tooEarly
              ? `Pick ${formatDate(tooEarly)} or later`
              : valid
                ? ''
                : `Pick ${formatDate(latest)} or earlier`
        setError(problem)
        if (problem) return
        close.mutate(periodEnd, {
          onSuccess: (statement) => navigate(`/groups/${group.$id}/statements/${statement.$id}`),
        })
      }}
    >
      <h2 id="close-heading" ref={heading} tabIndex={-1} className="font-medium outline-none">
        Close the period now?
      </h2>
      <p className="text-sm">
        This drafts {group.type === 'house' ? 'a divide' : 'an invoice'} now, up to the last day you
        pick. You review and finalize it as usual.
      </p>
      <TextField
        id="closePeriodEnd"
        type="date"
        label="Last day"
        min={first}
        max={latest}
        value={periodEnd}
        onChange={(event) => setPeriodEnd(event.target.value)}
        error={error ? { type: 'validate', message: error } : undefined}
      />
      {/* Mounted from the start, so a change is read out. */}
      <p role="status" className="text-sm break-words empty:hidden">
        {covers}
      </p>
      {close.error instanceof UnfinishedDraft ? (
        <Message alert>
          {close.error.message}{' '}
          <Link
            to={`/groups/${group.$id}/statements/${close.error.draftId}`}
            className="underline underline-offset-4"
          >
            Open the earlier draft
          </Link>
        </Message>
      ) : (
        close.isError && <Message alert>{close.error.message}</Message>
      )}
      <div className="flex flex-wrap gap-3">
        {/* aria-disabled, not disabled: a disabled button loses focus. */}
        <Button type="submit" aria-disabled={close.isPending}>
          {close.isPending ? 'Closing…' : 'Close period'}
        </Button>
        <Button
          variant="ghost"
          aria-disabled={close.isPending}
          onClick={() => !close.isPending && onCancel()}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
