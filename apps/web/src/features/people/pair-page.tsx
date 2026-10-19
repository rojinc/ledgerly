import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type ReactNode, useEffect, useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { Link, useParams } from 'react-router'
import { queryKeys } from '../../lib/query-keys'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { centsToText } from '../groups/employer-form'
import { useBalances, useGroup, useMyMember } from '../groups/use-groups'
import { KIND_LABEL, STATUS_LABEL } from '../transactions/history-page'
import type { EntryEdit } from '../transactions/new-transaction-page'
import {
  LedgerError,
  useCreateTransaction,
  useHistory,
  useMembers,
} from '../transactions/use-transactions'
import {
  balanceText,
  cents,
  DEFAULT_DESCRIPTION,
  debtor,
  type EntryType,
  type EntryValues,
  owedBy,
  type PairPeople,
  toEntryBody,
} from './pair-values'

const ENTRY_TYPES: { value: EntryType; label: (name: string) => string }[] = [
  { value: 'lent', label: (name) => `I lent ${name} money` },
  { value: 'borrowed', label: (name) => `I borrowed from ${name}` },
  { value: 'repaid', label: () => 'Money was paid back' },
]

// The body's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof EntryValues> = {
  totalCents: 'amount',
  date: 'date',
  description: 'description',
  note: 'note',
}

/** An amount as typed in this currency: `40.50`, or `4050` for one without cents. */
function amountExample(currency: string): string {
  return centsToText(4050, currency)
}

/** Schema errors on the fields the form shows, in plain words. */
function entryResolver(
  toBody: (values: EntryValues) => ReturnType<typeof toEntryBody>,
  currency: string,
): Resolver<EntryValues, unknown, TransactionInput> {
  const resolve = schemaResolver<EntryValues, TransactionInput>(transactionInputSchema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof EntryValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const total = toBody(values).totalCents
    if (values.amount.trim() === '') add('amount', 'Required')
    else if (get(found, 'totalCents') || Number.isNaN(total)) {
      add('amount', `Enter an amount like ${amountExample(currency)}`)
    } else if (typeof total === 'number' && total <= 0) add('amount', 'Enter an amount above 0')
    for (const [path, field] of Object.entries(ERROR_FIELD)) {
      const message = get(found, path)?.message as string | undefined
      if (message) add(field, message)
    }
    if (Object.keys(errors).length > 0)
      return { values: {}, errors: errors as FieldErrors<EntryValues> }
    if (Object.keys(found).length > 0) {
      return {
        values: {},
        errors: { root: { type: 'validate', message: 'Something in the form is not valid.' } },
      }
    }
    return result
  }
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

/** `/people/{groupId}`: what's owed with one person, recording lent, borrowed and repaid (#34). */
export function PairPage() {
  const groupId = useParams().groupId ?? ''
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const me = bootstrap.data?.personId ?? ''
  const group = useGroup(groupId)
  const members = useMembers(groupId)
  const member = useMyMember(groupId, me)
  // Until the viewer's person is known, either member could be the other one.
  const them = me ? members.data?.find((row) => row.personId !== me) : undefined

  let content: ReactNode
  if (!group.data || !members.data || member.data === undefined) {
    content =
      (group.isError && !group.data) ||
      (members.isError && !members.data) ||
      member.isError ||
      bootstrap.isError ? (
        <Message alert>We couldn’t load this. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (group.data.type !== 'pair' || !them) {
    content = <Message>This isn’t a lend & borrow group.</Message>
  } else {
    content = (
      <PairDetails
        group={group.data}
        people={{ me, them: them.personId }}
        name={them.displayName}
        // D-016: a placeholder may or may not have an account; this says only that they haven't joined.
        joined={them.status !== 'placeholder'}
        mayAdd={member.data?.role === 'admin' || member.data?.role === 'member'}
      />
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="min-w-0 text-2xl font-semibold break-words">
        {them?.displayName ?? group.data?.name ?? 'Lend & borrow'}
      </h1>
      {content}
    </div>
  )
}

function PairDetails({
  group,
  people,
  name,
  joined,
  mayAdd,
}: {
  group: Groups
  people: PairPeople
  name: string
  joined: boolean
  mayAdd: boolean
}) {
  const balances = useBalances(group.$id)
  const net = balances.data?.people.find((person) => person.personId === people.me)?.netCents
  return (
    <>
      {!joined && <p className="text-sm text-muted-foreground">Not joined yet</p>}
      <section
        aria-labelledby="balance-heading"
        className="flex flex-col gap-1 rounded-md border border-border p-4"
      >
        <h2 id="balance-heading" className="text-sm text-muted-foreground">
          Balance
        </h2>
        <p className="text-xl font-semibold" aria-live="polite">
          {balances.data
            ? balanceText(net ?? 0, name, group.currency)
            : balances.isError
              ? 'Not available yet'
              : 'Loading…'}
        </p>
        {balances.isError && !balances.data && (
          <Button variant="outline" className="self-start" onClick={() => balances.refetch()}>
            Try again
          </Button>
        )}
      </section>
      {group.archivedAt ? (
        <Message>{ARCHIVED_NOTICE}</Message>
      ) : (
        mayAdd &&
        balances.data && <EntryForm group={group} people={people} name={name} net={net ?? 0} />
      )}
      <History group={group} />
    </>
  )
}

/** Changing a posted entry (#184): as the employer form's, with this form's values. */
export type PairEdit = Omit<EntryEdit, 'values'> & { values: EntryValues }

/**
 * The entry form (#34): a new entry, or a posted one being changed. On a change the kind stays:
 * a loan switches between lent and borrowed, and a repayment stays one.
 */
export function EntryForm({
  group,
  people,
  name,
  net,
  edit,
}: {
  group: Groups
  people: PairPeople
  name: string
  /** The viewer's balance, which a new entry's repayment starts from. */
  net: number
  edit?: PairEdit
}) {
  const create = useCreateTransaction()
  const editing = edit !== undefined
  const queryClient = useQueryClient()
  // One ID per entry, so a retry after an error can't add it twice; a new one once it's saved.
  // A change keeps the row's.
  const [id, setId] = useState(() => edit?.row.$id ?? ID.unique())
  const [saved, setSaved] = useState(false)
  const types = edit
    ? ENTRY_TYPES.filter((entry) => (entry.value === 'repaid') === (edit.row.kind === 'payment'))
    : ENTRY_TYPES
  const toBody = (values: EntryValues) =>
    toEntryBody(values, { id, groupId: group.$id }, group.currency, people)
  const defaults = (): EntryValues => ({
    type: 'lent',
    amount: '',
    date: localToday(group.timezone, new Date()),
    description: '',
    note: '',
    from: debtor(net),
  })
  const form = useForm<EntryValues, unknown, TransactionInput>({
    resolver: entryResolver(toBody, group.currency),
    defaultValues: edit?.values ?? defaults(),
  })
  const { errors, isSubmitting } = form.formState
  // The balance moves after each entry: who owes, and so who repays, may change with it. A
  // change keeps who repaid as stored.
  useEffect(() => {
    if (!editing && !form.getFieldState('from').isDirty) form.setValue('from', debtor(net))
  }, [form, net, editing])
  const [type, from, amount] = form.watch(['type', 'from', 'amount'])
  const owed = owedBy(from, net)
  const typed = cents(amount, group.currency)
  // Prefilled from the balance until the amount is typed in, so part repayments work.
  const prefill = (nextFrom: EntryValues['from']) => {
    if (edit || form.getFieldState('amount').isDirty) return
    const due = owedBy(nextFrom, net)
    form.setValue('amount', due > 0 ? centsToText(due, group.currency) : '')
  }

  const submit = form.handleSubmit(async (body) => {
    if (edit) {
      try {
        // Saving it unchanged is fine: the function answers with the row as it is.
        await edit.save(body)
        edit.onDone()
      } catch (error) {
        form.setError('root', { message: (error as Error).message })
      }
      return
    }
    try {
      await create.mutateAsync(body)
      setId(ID.unique())
      form.reset(defaults())
      setSaved(true)
    } catch (error) {
      const code = error instanceof LedgerError ? error.code : undefined
      if (code === 'CONFLICT') {
        // The same ID with different content: an earlier try was saved though its answer was
        // lost, or the ID is taken. Show what's stored, and use a new ID for the next try.
        void queryClient.invalidateQueries({ queryKey: ['history', group.$id] })
        void queryClient.invalidateQueries({ queryKey: queryKeys.balances(group.$id) })
        setId(ID.unique())
      }
      // Archived meanwhile: reload the group, so the page shows it read-only.
      if (code === 'ARCHIVED') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.group(group.$id) })
      }
      form.setError('root', {
        message:
          code === 'CONFLICT'
            ? 'This may already have been saved from your last try. Check the list below before adding it again.'
            : (error as Error).message,
      })
    }
  })

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on Add; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      {edit ? (
        <h2 id="edit-heading" ref={edit.heading} tabIndex={-1} className="font-medium outline-none">
          Change this entry
        </h2>
      ) : (
        <h2 className="font-medium">Record</h2>
      )}
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">What happened?</legend>
        {types.map((entry) => (
          <label key={entry.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value={entry.value}
              {...form.register('type', {
                onChange: (event) => {
                  setSaved(false)
                  if (event.target.value === 'repaid') prefill(form.getValues('from'))
                },
              })}
            />
            {entry.label(name)}
          </label>
        ))}
      </fieldset>
      {type === 'repaid' && (
        <SelectField
          id="from"
          label="Who paid back?"
          {...form.register('from', { onChange: (event) => prefill(event.target.value) })}
        >
          <option value="them">{name} paid me</option>
          <option value="me">I paid {name}</option>
        </SelectField>
      )}
      <TextField
        id="amount"
        inputMode="decimal"
        label={`Amount (${group.currency})`}
        hint={`For example ${amountExample(group.currency)}.`}
        error={errors.amount}
        {...form.register('amount', { onChange: () => setSaved(false) })}
      />
      {/* A warning, not an error: paying back more just turns the balance the other way. */}
      {!edit && type === 'repaid' && Number.isInteger(typed) && typed > owed && (
        <p role="status" className="text-sm text-muted-foreground">
          {owed === 0
            ? `Nothing is owed that way right now, so this will be owed the other way.`
            : `That’s more than ${from === 'them' ? `${name} owes you` : `you owe ${name}`} (${formatMoney(owed, group.currency)}). The rest will be owed the other way.`}
        </p>
      )}
      <TextField
        id="date"
        type="date"
        label="Date"
        error={errors.date}
        {...form.register('date')}
      />
      <TextField
        id="description"
        label="Description (optional)"
        hint={`Left blank, it says “${DEFAULT_DESCRIPTION[type]}”.`}
        error={errors.description}
        {...form.register('description')}
      />
      <TextField id="note" label="Note (optional)" error={errors.note} {...form.register('note')} />
      <div className="flex items-center gap-3">
        <Button type="submit" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : edit ? 'Save' : 'Add'}
        </Button>
        {edit && (
          // Not while saving: the save would still land, after the form had gone.
          <Button
            type="button"
            variant="outline"
            aria-disabled={isSubmitting}
            onClick={() => {
              if (!form.formState.isSubmitting) edit.onDone()
            }}
          >
            Cancel
          </Button>
        )}
        {saved && (
          <p role="status" className="text-sm text-muted-foreground">
            Added.
          </p>
        )}
      </div>
    </form>
  )
}

/** The group's transactions, newest first, cursor-paged on `idx_group_date` (#31's history). */
function History({ group }: { group: Groups }) {
  const history = useHistory(group.$id, {})
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
        History
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nothing recorded yet.</p>
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
                    className={`block font-medium break-words ${row.status === 'void' ? 'line-through' : ''}`}
                  >
                    {row.description}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {row.date} · {KIND_LABEL[row.kind]} · {STATUS_LABEL[row.status]}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(row.totalCents, group.currency)}
                </span>
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
