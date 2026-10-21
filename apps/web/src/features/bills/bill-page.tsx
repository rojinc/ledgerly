import { isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { centsToText } from '../groups/employer-form'
import { useGroup, useMyMember } from '../groups/use-groups'
import { formatDate } from '../statements/invoice-view'
import { LedgerError, useMembers, useTransaction } from '../transactions/use-transactions'
import { BillForm } from './bill-form'
import { isOverdue, storedExtras, toBillValues } from './bill-values'
import { Message, useHouse, usePersonalGroup } from './bills-page'
import { defaultBillSplit, newHouseBillValues, toHouseBillValues } from './house-bill'
import { HouseBillForm } from './house-bill-form'
import { markStale, useMarkPaid, useSaveBill, useSkipBill } from './use-bills'

/** `/bills/new`: a bill in the personal group (#75), or with `?groupId=` in a house (#44). */
export function NewBillPage() {
  const groupId = useSearchParams()[0].get('groupId')
  return groupId ? <NewHouseBillPage groupId={groupId} /> : <NewPersonalBillPage />
}

/**
 * For a refused create: the same ID again with different content means an earlier try was saved
 * although its answer was lost, and the form changed since. Opens the bill as saved, rather than
 * refusing forever. Anything else is thrown again.
 */
function useOpenSaved(id: string, personId: string) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return async (error: unknown) => {
    if (!(error instanceof LedgerError && error.code === 'CONFLICT')) throw error
    const row = await tablesDB
      .getRow<Transactions>({ databaseId: DATABASE_ID, tableId: 'transactions', rowId: id })
      .catch(() => {
        throw error
      })
    // Only the bill this visit sent: the caller's own, and a bill.
    if (row.createdBy !== personId || row.kind !== 'bill') throw error
    queryClient.setQueryData(queryKeys.transaction(id), row)
    // The lost answer's refresh never ran.
    markStale(queryClient, row.groupId)
    navigate(`/bills/${id}`, { replace: true, state: { alreadySaved: true } })
  }
}

/** A bill in the personal group, due or already paid. */
function NewPersonalBillPage() {
  const personal = usePersonalGroup()
  const navigate = useNavigate()
  const save = useSaveBill()
  // One ID per visit, so retrying after an error can't add the bill twice.
  const [id] = useState(() => ID.unique())
  const openSaved = useOpenSaved(id, personal.personId)
  let content: ReactNode
  if (personal.group) {
    const today = localToday(personal.group.timezone, new Date())
    content = (
      <BillForm
        group={personal.group}
        id={id}
        defaultValues={{
          description: '',
          category: '',
          amount: '',
          dueOn: today,
          paid: false,
          paidOn: today,
        }}
        submitLabel="Add bill"
        canMarkPaid
        onSave={async (body) => {
          try {
            await save.mutateAsync({ body, isNew: true })
          } catch (error) {
            await openSaved(error)
            return
          }
          navigate(`/bills/${id}`, { replace: true })
        }}
      />
    )
  } else {
    content = personal.isError ? (
      <Message alert>We couldn’t load your bills. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New bill</h1>
      {content}
    </div>
  )
}

/** A house bill (#44), due or already paid, by days present or the house's default split. */
function NewHouseBillPage({ groupId }: { groupId: string }) {
  const { house, personId, canAdd, roleKnown } = useHouse(groupId)
  const members = useMembers(groupId)
  const navigate = useNavigate()
  const save = useSaveBill()
  // One ID per visit, so retrying after an error can't add the bill twice.
  const [id] = useState(() => ID.unique())
  const openSaved = useOpenSaved(id, personId)
  let content: ReactNode
  if (house === null) {
    content = <Message alert>We couldn’t find that house.</Message>
  } else if (!house || !members.data || personId === '' || !roleKnown) {
    content = members.isError ? (
      <Message alert>We couldn’t load this house. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  } else if (!canAdd) {
    content = (
      <Message>
        {house.archivedAt ? ARCHIVED_NOTICE : 'You can see this house’s bills but not add to them.'}
      </Message>
    )
  } else {
    content = (
      <HouseBillForm
        group={house}
        members={members.data}
        personId={personId}
        id={id}
        defaultValues={newHouseBillValues(
          localToday(house.timezone, new Date()),
          personId,
          defaultBillSplit(house),
        )}
        submitLabel="Add bill"
        canMarkPaid
        onSave={async (body) => {
          try {
            await save.mutateAsync({ body, isNew: true })
          } catch (error) {
            await openSaved(error)
            return
          }
          navigate(`/bills/${id}`, { replace: true })
        }}
      />
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold break-words">
        {house ? `New bill · ${house.name}` : 'New bill'}
      </h1>
      {content}
    </div>
  )
}

/** `/bills/{id}`: one bill; a due one can be marked paid, changed or skipped. */
export function BillPage() {
  const id = useParams().billId ?? ''
  const transaction = useTransaction(id)
  // Each action's panel goes once the bill changes: focus lands here, and the result is read out.
  const heading = useRef<HTMLHeadingElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  // Shown on this visit only: the history entry's state is cleared, so a reload doesn't repeat it.
  const [alreadySaved] = useState(
    () => (location.state as { alreadySaved?: boolean } | null)?.alreadySaved,
  )
  useEffect(() => {
    if (location.state) navigate('.', { replace: true, state: null })
  }, [location.state, navigate])
  return (
    <div className="flex flex-col gap-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold break-words outline-none">
        {transaction.data?.description ?? 'Bill'}
      </h1>
      {alreadySaved && (
        <Message>
          This bill was already added by an earlier try. Here it is as saved: change it here if you
          need to.
        </Message>
      )}
      {transaction.data ? (
        <BillDetails row={transaction.data} onDone={() => heading.current?.focus()} />
      ) : transaction.isError ? (
        <Message alert>We couldn’t load this bill. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

function BillDetails({ row, onDone }: { row: Transactions; onDone: () => void }) {
  const group = useGroup(row.groupId)
  const [done, setDone] = useState('')
  const [editing, setEditing] = useState(false)
  const editHeading = useRef<HTMLHeadingElement>(null)
  const finish = (message: string) => {
    setEditing(false)
    setDone(message)
    onDone()
  }
  const cancelEdit = () => {
    // The form and its Cancel go: keep focus on the page.
    setEditing(false)
    onDone()
  }

  if (!group.data) {
    return group.isError ? (
      <Message alert>We couldn’t load this bill. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  if (row.kind !== 'bill') return <Message>This isn’t a bill.</Message>

  const house = group.data.type === 'house'
  const { periodStart, periodEnd } = storedExtras(row.inputJson).period ?? {}
  const today = localToday(group.data.timezone, new Date())
  const dueOn = row.dueOn ?? row.date
  const status =
    row.status === 'due'
      ? isOverdue(dueOn, today)
        ? `Overdue: it was due ${formatDate(dueOn)}.`
        : `Due ${formatDate(dueOn)}.`
      : row.status === 'void'
        ? `Skipped.${row.voidReason ? ` Reason: ${row.voidReason}` : ''}`
        : `Paid ${formatDate(row.date)}.`
  return (
    <>
      <p className="text-muted-foreground">{status}</p>
      {/* Mounted from the start, so a change is read out. */}
      <p role="status" className="text-sm empty:sr-only">
        {done}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="tabular-nums">{formatMoney(row.totalCents, group.data.currency)}</dd>
        {periodStart && periodEnd && (
          <>
            <dt className="text-muted-foreground">Period</dt>
            <dd>
              {formatDate(periodStart)} – {formatDate(periodEnd)}
            </dd>
          </>
        )}
        {row.category && (
          <>
            <dt className="text-muted-foreground">Category</dt>
            <dd>
              {row.category[0]?.toUpperCase()}
              {row.category.slice(1)}
            </dd>
          </>
        )}
      </dl>
      {row.status === 'due' && (
        <MayChange row={row} group={group.data}>
          {editing ? (
            <section aria-labelledby="edit-heading" className="flex flex-col gap-3">
              <h2
                id="edit-heading"
                ref={editHeading}
                tabIndex={-1}
                className="font-medium outline-none"
              >
                Change this bill
              </h2>
              {house ? (
                <EditHouseBill
                  row={row}
                  group={group.data}
                  onSaved={() => finish('Saved.')}
                  onCancel={cancelEdit}
                />
              ) : (
                <EditBill
                  row={row}
                  group={group.data}
                  onSaved={() => finish('Saved.')}
                  onCancel={cancelEdit}
                />
              )}
            </section>
          ) : (
            <>
              {house ? (
                <HouseMarkPaid row={row} today={today} onPaid={() => finish('Marked paid.')} />
              ) : (
                <MarkPaid row={row} today={today} onPaid={() => finish('Marked paid.')} />
              )}
              <Button
                variant="outline"
                className="self-start"
                onClick={() => {
                  // The button goes as the form opens: focus moves to the form's heading.
                  flushSync(() => setEditing(true))
                  editHeading.current?.focus()
                }}
              >
                Change this bill
              </Button>
              <SkipBill row={row} onSkipped={() => finish('Skipped.')} />
            </>
          )}
        </MayChange>
      )}
    </>
  )
}

/**
 * A house bill's actions, for its creator or an admin only, and never on a bill locked by a
 * statement or in an archived house (permissions.md); the function checks again. A personal bill
 * is always its owner's.
 */
function MayChange({
  row,
  group,
  children,
}: {
  row: Transactions
  group: Groups
  children: ReactNode
}) {
  return group.type === 'house' ? (
    <IfHouseMayChange row={row} group={group}>
      {children}
    </IfHouseMayChange>
  ) : (
    children
  )
}

function IfHouseMayChange({
  row,
  group,
  children,
}: {
  row: Transactions
  group: Groups
  children: ReactNode
}) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const role = useMyMember(row.groupId, personId).data?.role
  const mayChange = role === 'admin' || (role === 'member' && row.createdBy === personId)
  return mayChange && !group.archivedAt && row.statementId === null ? children : null
}

function EditBill({
  row,
  group,
  onSaved,
  onCancel,
}: {
  row: Transactions
  group: Groups
  onSaved: () => void
  onCancel: () => void
}) {
  const save = useSaveBill()
  return (
    <>
      <BillForm
        group={group}
        id={row.$id}
        defaultValues={toBillValues(row, centsToText(row.totalCents, group.currency))}
        submitLabel="Save"
        canMarkPaid={false}
        kept={storedExtras(row.inputJson)}
        onSave={async (body) => {
          await save.mutateAsync({ body, isNew: false })
          onSaved()
        }}
      />
      <Button variant="ghost" className="self-start" onClick={onCancel}>
        Cancel
      </Button>
    </>
  )
}

/** A due house bill's changes (#44): the period and split too, and who paid is kept. */
function EditHouseBill({
  row,
  group,
  onSaved,
  onCancel,
}: {
  row: Transactions
  group: Groups
  onSaved: () => void
  onCancel: () => void
}) {
  const save = useSaveBill()
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const members = useMembers(row.groupId)
  const kept = storedExtras(row.inputJson)
  if (!members.data || personId === '') {
    return members.isError ? (
      <Message alert>We couldn’t load this house. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  return (
    <>
      <HouseBillForm
        group={group}
        members={members.data}
        personId={personId}
        id={row.$id}
        defaultValues={toHouseBillValues(
          row,
          centsToText(row.totalCents, group.currency),
          kept,
          personId,
          defaultBillSplit(group),
        )}
        submitLabel="Save"
        canMarkPaid={false}
        kept={kept}
        nested
        onSave={async (body) => {
          await save.mutateAsync({ body, isNew: false })
          onSaved()
        }}
      />
      <Button variant="ghost" className="self-start" onClick={onCancel}>
        Cancel
      </Button>
    </>
  )
}

/** Mark paid in a house: who paid it all, any member, by default the viewer (#44). */
function HouseMarkPaid(props: { row: Transactions; today: string; onPaid: () => void }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const members = useMembers(props.row.groupId)
  if (members.isError) {
    return <Message alert>We couldn’t load this house. Reload the page to try again.</Message>
  }
  if (!members.data || personId === '') return <Message>Loading…</Message>
  const people = [...members.data].sort((a, b) => a.displayName.localeCompare(b.displayName))
  return <MarkPaid {...props} payer={{ members: people, personId }} />
}

function MarkPaid({
  row,
  today,
  onPaid,
  payer,
}: {
  row: Transactions
  today: string
  onPaid: () => void
  /** In a house: the members who could have paid, and the viewer, who did by default. */
  payer?: { members: Members[]; personId: string }
}) {
  const markPaid = useMarkPaid(row.$id)
  // Local today in the group's time zone (#75).
  const [date, setDate] = useState(today)
  const [paidBy, setPaidBy] = useState(payer?.personId ?? '')
  const [error, setError] = useState('')
  return (
    <form
      noValidate
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (markPaid.isPending) return
        if (!isLocalDate(date)) {
          setError('Enter the date it was paid')
          return
        }
        setError('')
        markPaid.mutate(
          // The whole amount, by one person (ledger.md#payers).
          payer ? { date, payers: [{ personId: paidBy, cents: row.totalCents }] } : { date },
          { onSuccess: onPaid },
        )
      }}
    >
      <TextField
        id="paidOn"
        type="date"
        label="Paid on"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        error={error ? { type: 'validate', message: error } : undefined}
      />
      {payer && (
        <SelectField
          id="markPaidBy"
          label="Paid by"
          value={paidBy}
          onChange={(event) => setPaidBy(event.target.value)}
        >
          {payer.members.map((member) => (
            <option key={member.personId} value={member.personId}>
              {member.displayName}
            </option>
          ))}
        </SelectField>
      )}
      {markPaid.isError && <Message alert>{markPaid.error.message}</Message>}
      {/* aria-disabled, not disabled: a disabled button loses focus. */}
      <Button type="submit" className="self-start" aria-disabled={markPaid.isPending}>
        {markPaid.isPending ? 'Marking paid…' : 'Mark paid'}
      </Button>
    </form>
  )
}

function SkipBill({ row, onSkipped }: { row: Transactions; onSkipped: () => void }) {
  const skip = useSkipBill(row.$id)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  return (
    <form
      noValidate
      className="flex flex-col gap-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (skip.isPending) return
        if (reason.trim() === '') {
          setError('Say why, for example “Paid by someone else”.')
          return
        }
        setError('')
        skip.mutate({ reason: reason.trim() }, { onSuccess: onSkipped })
      }}
    >
      <TextField
        id="skipReason"
        label="Reason for skipping"
        maxLength={200}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={error ? { type: 'validate', message: error } : undefined}
      />
      {skip.isError && <Message alert>{skip.error.message}</Message>}
      <Button type="submit" variant="outline" className="self-start" aria-disabled={skip.isPending}>
        {skip.isPending ? 'Skipping…' : 'Skip this bill'}
      </Button>
    </form>
  )
}
