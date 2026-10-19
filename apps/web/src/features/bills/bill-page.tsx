import { isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { ID } from 'appwrite'
import { type ReactNode, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { centsToText } from '../groups/employer-form'
import { useGroup } from '../groups/use-groups'
import { formatDate } from '../statements/invoice-view'
import { LedgerError, useTransaction } from '../transactions/use-transactions'
import { BillForm } from './bill-form'
import { isOverdue, storedExtras, toBillValues } from './bill-values'
import { Message, usePersonalGroup } from './bills-page'
import { useMarkPaid, useSaveBill, useSkipBill } from './use-bills'

/** `/bills/new`: a bill in the personal group, due or already paid. */
export function NewBillPage() {
  const personal = usePersonalGroup()
  const navigate = useNavigate()
  const save = useSaveBill()
  // One ID per visit, so retrying after an error can't add the bill twice.
  const [id] = useState(() => ID.unique())
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
            // The same ID again, with different content: an earlier try may have been saved
            // although its answer was lost. Say so, rather than inviting a duplicate.
            if (error instanceof LedgerError && error.code === 'CONFLICT') {
              throw new Error(
                'This may already have been saved from your last try. Check Bills before adding it again.',
              )
            }
            throw error
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

/** `/bills/{id}`: one bill; a due one can be marked paid, changed or skipped. */
export function BillPage() {
  const id = useParams().billId ?? ''
  const transaction = useTransaction(id)
  // Each action's panel goes once the bill changes: focus lands here, and the result is read out.
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <div className="flex flex-col gap-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold break-words outline-none">
        {transaction.data?.description ?? 'Bill'}
      </h1>
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
  const finish = (message: string) => {
    setEditing(false)
    setDone(message)
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
      <p role="status" className="text-sm empty:hidden">
        {done}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="tabular-nums">{formatMoney(row.totalCents, group.data.currency)}</dd>
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
      {row.status === 'due' &&
        (editing ? (
          <section aria-labelledby="edit-heading" className="flex flex-col gap-3">
            <h2 id="edit-heading" className="font-medium">
              Change this bill
            </h2>
            <EditBill
              row={row}
              group={group.data}
              onSaved={() => finish('Saved.')}
              onCancel={() => {
                // The form and its Cancel go: keep focus on the page.
                setEditing(false)
                onDone()
              }}
            />
          </section>
        ) : (
          <>
            <MarkPaid row={row} today={today} onPaid={() => finish('Marked paid.')} />
            <Button variant="outline" className="self-start" onClick={() => setEditing(true)}>
              Change this bill
            </Button>
            <SkipBill row={row} onSkipped={() => finish('Skipped.')} />
          </>
        ))}
    </>
  )
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

function MarkPaid({
  row,
  today,
  onPaid,
}: {
  row: Transactions
  today: string
  onPaid: () => void
}) {
  const markPaid = useMarkPaid(row.$id)
  // Local today in the group's time zone (#75).
  const [date, setDate] = useState(today)
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
        markPaid.mutate({ date }, { onSuccess: onPaid })
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
