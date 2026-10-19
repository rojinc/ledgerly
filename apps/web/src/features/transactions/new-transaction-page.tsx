import { CATEGORIES } from '@ledgerly/core/constants/categories'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { ID } from 'appwrite'
import { type ReactNode, useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroups, useMyMember } from '../groups/use-groups'
import { HouseExpenseForm } from './house-expense-form'
import {
  amountError,
  amountExample,
  type EmployerPeople,
  ENTRY_TYPES,
  type EntryValues,
  toEntryBody,
} from './presets'
import { employerPeople, LedgerError, useCreateTransaction, useMembers } from './use-transactions'

// The body's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof EntryValues> = {
  totalCents: 'amount',
  date: 'date',
  description: 'description',
  category: 'category',
  note: 'note',
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
    const amount = amountError(
      values.amount,
      toBody(values).totalCents,
      Boolean(get(found, 'totalCents')),
      currency,
    )
    if (amount) add('amount', amount)
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

/**
 * `/transactions/new?groupId=`: an employer expense preset or a payment received (#31), or a
 * house expense (#180).
 */
export function NewTransactionPage() {
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const personId = bootstrap.data?.personId ?? ''
  const groups = useGroups()
  const [params] = useSearchParams()
  const group = groups.data?.find(
    (g) => g.$id === params.get('groupId') && (g.type === 'employer' || g.type === 'house'),
  )
  const member = useMyMember(group?.$id ?? '', personId)
  const members = useMembers(group?.$id ?? '')

  let content: ReactNode
  if (!groups.data || (group && (member.data === undefined || !members.data))) {
    content =
      (groups.isError && !groups.data) || member.isError || members.isError || bootstrap.isError ? (
        <Message alert>We couldn’t load this group. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (!group) {
    content = (
      <Message>
        Pick an employer or a house from{' '}
        <Link to="/groups" className="underline underline-offset-4">
          Groups
        </Link>{' '}
        first.
      </Message>
    )
  } else if (group.archivedAt) {
    content = <Message>This group is archived. You can see its history but not change it.</Message>
  } else if (
    // The presets are worded from the worker's side ("I paid for them"), so only the group's
    // owner, the worker it pays, adds here (as only they start the timer).
    group.type === 'employer' &&
    group.ownerPersonId !== personId
  ) {
    content = <Message>Only the person this group pays adds expenses and payments here.</Message>
  } else if (member.data?.role !== 'admin' && member.data?.role !== 'member') {
    content = (
      <Message>
        You can see this {group.type === 'house' ? 'house' : 'group'}’s history but no longer add to
        it.
      </Message>
    )
  } else if (group.type === 'house') {
    content = <HouseExpenseForm group={group} members={members.data ?? []} personId={personId} />
  } else {
    const people = employerPeople(group, members.data)
    content = people ? (
      <EntryForm group={group} people={people} />
    ) : (
      <Message alert>
        This employer group is missing its employer. Reload the page to try again.
      </Message>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">
        {group?.type === 'house' ? 'Add expense' : 'Add expense or payment'}
      </h1>
      {content}
    </div>
  )
}

function EntryForm({ group, people }: { group: Groups; people: EmployerPeople }) {
  const navigate = useNavigate()
  const create = useCreateTransaction()
  // One ID per visit, so a retry after an error can't add it twice.
  const [id] = useState(() => ID.unique())
  const toBody = (values: EntryValues) =>
    toEntryBody(values, { id, groupId: group.$id }, group.currency, people)
  const form = useForm<EntryValues, unknown, TransactionInput>({
    resolver: entryResolver(toBody, group.currency),
    defaultValues: {
      type: 'reimbursable',
      amount: '',
      date: localToday(group.timezone, new Date()),
      description: '',
      category: 'work',
      note: '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const type = form.watch('type')

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={form.handleSubmit(async (body) => {
        try {
          const view = await create.mutateAsync(body)
          navigate(`/transactions/${view.transaction.$id}`, { replace: true })
        } catch (error) {
          // The same ID again, with different content: an earlier try may have been saved
          // although its answer was lost. Say so, rather than inviting a duplicate.
          const message =
            error instanceof LedgerError && error.code === 'CONFLICT'
              ? 'This may already have been saved from your last try. Check History before adding it again.'
              : (error as Error).message
          form.setError('root', { message })
        }
      })}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">What happened with {group.name}?</legend>
        {ENTRY_TYPES.map((entry) => (
          <label key={entry.value} className="flex items-start gap-2 text-sm">
            <input type="radio" value={entry.value} className="mt-1" {...form.register('type')} />
            <span>
              <span className="block font-medium">{entry.label}</span>
              <span className="block text-muted-foreground">{entry.effect}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <TextField
        id="amount"
        inputMode="decimal"
        label={`Amount (${group.currency})`}
        hint={`For example ${amountExample(group.currency)}.`}
        error={errors.amount}
        {...form.register('amount')}
      />
      <TextField
        id="date"
        type="date"
        label="Date"
        error={errors.date}
        {...form.register('date')}
      />
      <TextField
        id="description"
        label="Description"
        hint={
          type === 'paymentReceived'
            ? 'For example “October pay”.'
            : 'For example “Cleaning supplies”.'
        }
        error={errors.description}
        {...form.register('description')}
      />
      {type !== 'paymentReceived' && (
        <SelectField
          id="category"
          label="Category"
          error={errors.category}
          {...form.register('category')}
        >
          <option value="">None</option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {category[0]?.toUpperCase()}
              {category.slice(1)}
            </option>
          ))}
        </SelectField>
      )}
      <TextField id="note" label="Note (optional)" error={errors.note} {...form.register('note')} />
      <Button type="submit" className="self-start" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Add'}
      </Button>
    </form>
  )
}
