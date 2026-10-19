import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { type ReactNode, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useSwap } from '../../lib/use-swap'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { useGroupName } from '../groups/use-group-name'
import { useGroup, useMyMember } from '../groups/use-groups'
import { EntryForm as PairEntryForm } from '../people/pair-page'
import { toPairValues } from '../people/pair-values'
import { ReceiptsSection } from '../receipts/receipts-section'
import { KIND_LABEL, STATUS_LABEL } from './history-page'
import { EntryForm } from './new-transaction-page'
import { toEntryValues } from './presets'
import {
  employerPeople,
  useHasItems,
  useMembers,
  useShares,
  useTransaction,
  useVoidTransaction,
} from './use-transactions'

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={`break-words ${alert ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {children}
    </p>
  )
}

// Only the mode, and the head count of an equal split, are read.
const SPLIT_TEXT: Record<string, string> = {
  exact: 'By amounts',
  percent: 'By percentages',
  weights: 'By shares',
}

function splitParts(split: { mode?: unknown; personIds?: unknown } | undefined) {
  const personIds = split?.personIds
  if (split?.mode === 'equal' && Array.isArray(personIds) && personIds.length > 0) {
    const count = personIds.length
    return { splitText: `Equally between ${count} ${count === 1 ? 'person' : 'people'}` }
  }
  const text = typeof split?.mode === 'string' ? SPLIT_TEXT[split.mode] : undefined
  return text ? { splitText: text } : {}
}

// Only the parts shown are read: a full template parse fails on stored inputs it doesn't model,
// such as a bill's.
function storedParts(inputJson: string): {
  note?: string
  shift?: { minutes: number; rateCents: number }
  /** How a house expense was split, in words (#180, #181). */
  splitText?: string
} {
  try {
    const stored = JSON.parse(inputJson) as {
      note?: unknown
      shift?: { minutes?: unknown; rateCents?: unknown }
      split?: { mode?: unknown; personIds?: unknown }
    } | null
    const note = typeof stored?.note === 'string' && stored.note !== '' ? stored.note : undefined
    const minutes = stored?.shift?.minutes
    const rateCents = stored?.shift?.rateCents
    const shift =
      Number.isInteger(minutes) && Number.isInteger(rateCents)
        ? { minutes: minutes as number, rateCents: rateCents as number }
        : undefined
    return {
      ...(note ? { note } : {}),
      ...(shift ? { shift } : {}),
      ...splitParts(stored?.split),
    }
  } catch {
    return {}
  }
}

/** `/transactions/{id}`: one transaction, linked from the calendar and history (#31). */
export function TransactionPage() {
  const id = useParams().transactionId ?? ''
  const transaction = useTransaction(id)
  return (
    <div className="flex flex-col gap-6">
      <h1 className="min-w-0 text-2xl font-semibold break-words">
        {transaction.data?.description ?? 'Transaction'}
      </h1>
      {transaction.data ? (
        <Details row={transaction.data} />
      ) : transaction.isError ? (
        <Message alert>We couldn’t load this transaction. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

function Details({ row }: { row: Transactions }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const personId = bootstrap.data?.personId ?? ''
  const group = useGroup(row.groupId)
  const member = useMyMember(row.groupId, personId)
  const members = useMembers(row.groupId)
  const shares = useShares(row.$id)
  // Here, not in the void form: an optimistic void hides the form, and after a rollback the
  // error and the typed reason must still be there.
  const voidRow = useVoidTransaction(row.$id)
  const [reason, setReason] = useState('')

  if (!group.data || member.data === undefined) {
    return (group.isError && !group.data) || member.isError || bootstrap.isError ? (
      <Message alert>We couldn’t load this transaction. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  const names = new Map((members.data ?? []).map((m) => [m.personId, m.displayName]))
  const role = member.data?.role
  // permissions.md: the creator or an admin, never a viewer; the function checks again.
  const mayChange = role === 'admin' || (role === 'member' && row.createdBy === personId)
  const locked = row.statementId !== null
  const archived = group.data.archivedAt !== null
  const open = mayChange && !locked && !archived
  const { note, shift, splitText } = storedParts(row.inputJson)

  return (
    <>
      <Message>
        {STATUS_LABEL[row.status]}
        {row.status === 'void' && row.voidReason ? `. Reason: ${row.voidReason}` : ''}
      </Message>
      {archived && <Message>{ARCHIVED_NOTICE}</Message>}
      {!archived && locked && <Message>It’s on a final invoice, so it can’t be changed.</Message>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm [&>dd]:min-w-0 [&>dd]:break-words">
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="tabular-nums">
          {row.status === 'running'
            ? 'Timer running'
            : formatMoney(row.totalCents, group.data.currency)}
        </dd>
        {/* A running timer stores 0 minutes until it stops. */}
        {row.kind === 'shift' && row.status !== 'running' && shift && (
          <>
            <dt className="text-muted-foreground">Shift</dt>
            <dd>
              {hoursText(shift.minutes)} at {formatMoney(shift.rateCents, group.data.currency)} an
              hour
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Date</dt>
        <dd>{row.date}</dd>
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{KIND_LABEL[row.kind]}</dd>
        {row.category && (
          <>
            <dt className="text-muted-foreground">Category</dt>
            <dd>
              {row.category[0]?.toUpperCase()}
              {row.category.slice(1)}
            </dd>
          </>
        )}
        {/* An employer entry's one-person split says nothing its type doesn't. */}
        {group.data.type === 'house' && splitText && (
          <>
            <dt className="text-muted-foreground">Split</dt>
            <dd>{splitText}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Group</dt>
        <dd>
          <GroupLink group={group.data} />
        </dd>
        {note && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd className="whitespace-pre-wrap">{note}</dd>
          </>
        )}
      </dl>
      {shares.data && shares.data.length > 0 && (
        <section aria-labelledby="shares-heading" className="flex flex-col gap-2">
          <h2 id="shares-heading" className="font-medium">
            {row.kind === 'shift'
              ? 'Who earned it, and who owes it'
              : 'Who paid, and who it was for'}
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {shares.data.map((share) => (
              <li key={share.$id} className="break-words">
                {names.get(share.personId) ?? 'Someone'}:{' '}
                {[
                  share.givenCents !== 0 &&
                    `${row.kind === 'shift' ? 'earned' : 'paid'} ${formatMoney(share.givenCents, group.data.currency)}`,
                  share.receivedCents !== 0 &&
                    `${row.kind === 'payment' ? 'received' : row.kind === 'shift' ? 'owes' : 'for them'} ${formatMoney(share.receivedCents, group.data.currency)}`,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ReceiptsSection
        row={row}
        group={group.data}
        mayChange={open && !['void', 'running'].includes(row.status)}
      />
      {open && <Change row={row} group={group.data} members={members.data} personId={personId} />}
      {open && row.status !== 'void' && (
        <VoidForm voidRow={voidRow} reason={reason} onReason={setReason} />
      )}
    </>
  )
}

/**
 * How the row is changed, for someone who may change it (#184): a posted employer or lend &
 * borrow entry here, with the form it was made with; a personal bill or a shift on its own page.
 */
function Change({
  row,
  group,
  members,
  personId,
}: {
  row: Transactions
  group: Groups
  members: Members[] | undefined
  personId: string
}) {
  // The bill page changes a due bill only, and the shift page a scheduled or posted shift.
  if (row.kind === 'bill' && group.type === 'personal' && row.status === 'due') {
    return (
      <Link to={`/bills/${row.$id}`} className="self-start underline underline-offset-4">
        Change this bill
      </Link>
    )
  }
  if (row.kind === 'shift' && (row.status === 'scheduled' || row.status === 'posted')) {
    return (
      <Link to={`/shifts/${row.$id}`} className="self-start underline underline-offset-4">
        Change this shift
      </Link>
    )
  }
  // A scheduled or due row stores no payer, so only a posted one has a choice to show.
  if (row.status !== 'posted') return null
  // As on create, only the worker changes an employer entry: the presets are worded from their side.
  const employer =
    group.type === 'employer' &&
    group.ownerPersonId === personId &&
    (row.kind === 'expense' || row.kind === 'payment')
  const pair = group.type === 'pair' && (row.kind === 'loan' || row.kind === 'payment')
  if (!employer && !pair) return null
  return <EditEntry row={row} group={group} members={members} personId={personId} />
}

const UNMATCHED = 'This entry can’t be changed here. Void it and add it again.'

/** Edit, swapping in the entry's form. Itemised rows (#42) get none yet. */
function EditEntry({
  row,
  group,
  members,
  personId,
}: {
  row: Transactions
  group: Groups
  members: Members[] | undefined
  personId: string
}) {
  const swap = useSwap()
  const items = useHasItems(row.$id)
  if (!members || items.data !== false) return null
  let form: ReactNode
  if (group.type === 'employer') {
    const people = employerPeople(group, members)
    const values = people && toEntryValues(row, people, group.currency)
    if (!people || !values) return <Message>{UNMATCHED}</Message>
    form = (
      <EntryForm
        group={group}
        people={people}
        edit={{ row, values, heading: swap.heading, onDone: swap.close }}
      />
    )
  } else {
    const them = members.find((member) => member.personId !== personId)
    const people = them && { me: personId, them: them.personId }
    const values = people && toPairValues(row, people, group.currency)
    if (!them || !people || !values) return <Message>{UNMATCHED}</Message>
    form = (
      <PairEntryForm
        group={group}
        people={people}
        name={them.displayName}
        edit={{ row, values, heading: swap.heading, onDone: swap.close }}
      />
    )
  }
  return swap.opened ? (
    <div className="flex flex-col gap-3 border-t border-border pt-4">{form}</div>
  ) : (
    <Button ref={swap.trigger} variant="outline" className="self-start" onClick={swap.open}>
      Edit
    </Button>
  )
}

/** `5 h 30 min`, `8 h` or `45 min`: no zero parts. */
function hoursText(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours > 0 && `${hours} h`, (rest > 0 || hours === 0) && `${rest} min`]
    .filter(Boolean)
    .join(' ')
}

function GroupLink({ group }: { group: Groups }) {
  const name = useGroupName(group)
  const to =
    group.type === 'employer'
      ? `/transactions?groupId=${group.$id}`
      : group.type === 'house'
        ? `/groups/${group.$id}`
        : undefined
  return to ? (
    <Link to={to} className="underline underline-offset-4">
      {name}
    </Link>
  ) : (
    name
  )
}

function VoidForm({
  voidRow,
  reason,
  onReason,
}: {
  voidRow: ReturnType<typeof useVoidTransaction>
  reason: string
  onReason: (reason: string) => void
}) {
  const [error, setError] = useState<string>()
  return (
    <form
      noValidate
      className="flex flex-col gap-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (reason.trim() === '') {
          setError('Say why, for example “Entered twice”.')
          return
        }
        setError(undefined)
        voidRow.mutate({ reason: reason.trim() })
      }}
    >
      <TextField
        id="voidReason"
        label="Reason for voiding"
        value={reason}
        maxLength={200}
        onChange={(event) => onReason(event.target.value)}
        error={error ? { type: 'validate', message: error } : undefined}
      />
      {voidRow.isError && <Message alert>{voidRow.error.message}</Message>}
      <Button type="submit" variant="outline" className="self-start" disabled={voidRow.isPending}>
        Void
      </Button>
    </form>
  )
}
