import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { ID } from 'appwrite'
import { useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import type { z } from 'zod'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { amountError, amountExample, cents } from './presets'
import { LedgerError, useCreateTransaction } from './use-transactions'

/** The adjustment form's fields, all as typed. */
export type AdjustmentValues = {
  /** Whose balance goes up by the amount. */
  owed: string
  /** Whose balance goes down by it. */
  owes: string
  amount: string
  date: string
  reason: string
}

/**
 * `POST /transactions` for an adjustment (ledger.md#transaction-kinds): the person owed more
 * gives the amount and the one who owes more receives it, so their nets change by it and the
 * shares balance. The reason is also its description, which statements show. NaN makes the
 * schema refuse an amount that isn't one.
 */
export function toAdjustmentBody(
  values: AdjustmentValues,
  ids: { id: string; groupId: string },
  currency: string,
): z.input<typeof transactionInputSchema> {
  const totalCents = cents(values.amount, currency)
  const reason = values.reason.trim()
  return {
    ...ids,
    kind: 'adjustment',
    date: values.date,
    description: reason,
    totalCents,
    adjustment: {
      shares: [
        { personId: values.owed, givenCents: totalCents, receivedCents: 0 },
        { personId: values.owes, givenCents: 0, receivedCents: totalCents },
      ].sort((a, b) => (a.personId < b.personId ? -1 : 1)),
      reason,
    },
  }
}

// The body's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof AdjustmentValues> = {
  date: 'date',
  description: 'reason',
  'adjustment.reason': 'reason',
}

/** Schema errors on the fields the form shows, in plain words. */
function adjustmentResolver(
  toBody: (values: AdjustmentValues) => ReturnType<typeof toAdjustmentBody>,
  currency: string,
): Resolver<AdjustmentValues, unknown, TransactionInput> {
  const resolve = schemaResolver<AdjustmentValues, TransactionInput>(transactionInputSchema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof AdjustmentValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    if (values.owes === values.owed) add('owes', 'Pick someone other than who is owed more')
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
      return { values: {}, errors: errors as FieldErrors<AdjustmentValues> }
    if (Object.keys(found).length > 0) {
      return {
        values: {},
        errors: { root: { type: 'validate', message: 'Something in the form is not valid.' } },
      }
    }
    return result
  }
}

/**
 * An adjustment (#400): moves an amount between two people's balances, the only way to correct
 * a final statement (statements.md core rule 3). It lands on the next one.
 */
export function AdjustmentForm({
  group,
  members,
  personId,
}: {
  group: Groups
  members: Members[]
  personId: string
}) {
  const navigate = useNavigate()
  const create = useCreateTransaction()
  // One ID per visit, so a retry after an error can't add it twice.
  const [id] = useState(() => ID.unique())
  const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName))
  const toBody = (values: AdjustmentValues) =>
    toAdjustmentBody(values, { id, groupId: group.$id }, group.currency)
  const form = useForm<AdjustmentValues, unknown, TransactionInput>({
    resolver: adjustmentResolver(toBody, group.currency),
    defaultValues: {
      // The caller is owed more by the first of the others: in an employer group, the worker
      // by the employer.
      owed: personId,
      owes: sorted.find((member) => member.personId !== personId)?.personId ?? '',
      amount: '',
      date: localToday(group.timezone, new Date()),
      reason: '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const statement = group.type === 'house' ? 'divide' : 'invoice'
  const submit = form.handleSubmit(async (body) => {
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
  })
  const people = sorted.map((member) => (
    <option key={member.personId} value={member.personId}>
      {member.displayName}
    </option>
  ))

  if (sorted.length < 2) {
    return (
      <p role="status" className="text-muted-foreground">
        An adjustment is between two people, and you’re the only one in this group.
      </p>
    )
  }
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      <p className="text-sm text-muted-foreground">
        A final {statement} never changes. An adjustment corrects a mistake on it: it moves an
        amount from one person’s balance to another’s, and shows on the next {statement}.
      </p>
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <SelectField
        id="owed"
        label="Who is owed more"
        hint="Their balance goes up by the amount."
        error={errors.owed}
        {...form.register('owed')}
      >
        {people}
      </SelectField>
      <SelectField
        id="owes"
        label="Who owes more"
        hint="Their balance goes down by the amount."
        error={errors.owes}
        {...form.register('owes')}
      >
        {people}
      </SelectField>
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
        id="reason"
        label="Reason"
        hint={`Shown on the next ${statement}. For example “${
          group.type === 'house'
            ? 'September power was split wrong'
            : 'Shift on 3 Oct was an hour short'
        }”.`}
        error={errors.reason}
        {...form.register('reason')}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Add'}
        </Button>
      </div>
    </form>
  )
}
