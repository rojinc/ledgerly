import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { Transfer } from '@ledgerly/core/settle/suggest-transfers'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { useEffect, useRef, useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { queryKeys } from '../../lib/query-keys'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextareaField, TextField } from '../../ui/field'
import { centsToText } from '../groups/employer-form'
import { cents } from '../people/pair-values'
import { LedgerError, useCreateTransaction } from '../transactions/use-transactions'

/** The record-payment form's fields, all as typed. `from` and `to` are person IDs. */
export type PaymentValues = {
  from: string
  to: string
  amount: string
  date: string
  description: string
  note: string
}

const DESCRIPTION = 'Settle up'

/**
 * `ledger POST /transactions` for a payment made outside the app (D-014): the whole amount from
 * one person to the other, with no payers or split (ledger.md#transaction-kinds).
 */
export function toPaymentBody(
  values: PaymentValues,
  ids: { id: string; groupId: string },
  currency: string,
): z.input<typeof transactionInputSchema> {
  const note = values.note.trim()
  return {
    ...ids,
    kind: 'payment',
    date: values.date,
    description: values.description.trim() || DESCRIPTION,
    totalCents: cents(values.amount, currency),
    payment: { fromPersonId: values.from, toPersonId: values.to },
    ...(note ? { note } : {}),
  }
}

// The body's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof PaymentValues> = {
  'payment.fromPersonId': 'from',
  date: 'date',
  description: 'description',
  note: 'note',
}

function paymentResolver(
  toBody: (values: PaymentValues) => ReturnType<typeof toPaymentBody>,
  currency: string,
): Resolver<PaymentValues, unknown, TransactionInput> {
  const resolve = schemaResolver<PaymentValues, TransactionInput>(transactionInputSchema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof PaymentValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const total = toBody(values).totalCents
    if (values.amount.trim() === '') add('amount', 'Required')
    else if (get(found, 'totalCents') || Number.isNaN(total)) {
      add('amount', `Enter an amount like ${centsToText(4050, currency)}`)
    } else if (typeof total === 'number' && total <= 0) add('amount', 'Enter an amount above 0')
    // The schema's refine: a payment needs two different people.
    if (get(found, 'payment.toPersonId')) {
      add('to', values.to === '' ? 'Required' : 'Pick someone other than who paid')
    }
    for (const [path, field] of Object.entries(ERROR_FIELD)) {
      const message = get(found, path)?.message as string | undefined
      if (message)
        add(field, field === 'from' ? 'Required' : field === 'date' ? 'Enter a date' : message)
    }
    if (Object.keys(errors).length > 0) {
      return { values: {}, errors: errors as FieldErrors<PaymentValues> }
    }
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
 * Record a payment, from a suggested transfer or blank. Anyone in the house can be in it,
 * including someone who moved out (I-3). The amount can be changed, so part payments work.
 */
export function PaymentForm({
  group,
  members,
  personId,
  transfer,
  onRecorded,
  onCancel,
}: {
  group: Groups
  members: Members[]
  /** The caller's person, for their member row. */
  personId: string
  transfer?: Transfer
  onRecorded: () => void
  onCancel: () => void
}) {
  const create = useCreateTransaction()
  const queryClient = useQueryClient()
  // One ID per payment, so a retry after an error can't record it twice.
  const [id, setId] = useState(() => ID.unique())
  const ref = useRef<HTMLFormElement>(null)
  const toBody = (values: PaymentValues) =>
    toPaymentBody(values, { id, groupId: group.$id }, group.currency)
  const form = useForm<PaymentValues, unknown, TransactionInput>({
    resolver: paymentResolver(toBody, group.currency),
    defaultValues: {
      from: transfer?.fromPersonId ?? '',
      to: transfer?.toPersonId ?? '',
      amount: transfer ? centsToText(transfer.cents, group.currency) : '',
      date: localToday(group.timezone, new Date()),
      description: DESCRIPTION,
      note: '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const people = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName))
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('select, input')?.focus()
  }, [])

  const submit = form.handleSubmit(async (body) => {
    try {
      await create.mutateAsync(body)
      onRecorded()
    } catch (error) {
      const code = error instanceof LedgerError ? error.code : undefined
      if (code === 'CONFLICT') {
        // The same ID with different content: an earlier try may have been saved though its
        // answer was lost. Show what's stored, and use a new ID for the next try.
        void queryClient.invalidateQueries({ queryKey: queryKeys.balances(group.$id) })
        void queryClient.invalidateQueries({ queryKey: ['history', group.$id] })
        void queryClient.invalidateQueries({ queryKey: ['calendar'] })
        setId(ID.unique())
      }
      // Archived, or the caller's role changed, meanwhile: reload them, so the page shows what
      // they can do now.
      if (code === 'ARCHIVED' || code === 'FORBIDDEN') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.group(group.$id) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.myMember(group.$id, personId) })
      }
      // The form keeps what was typed: after LOCKED (a statement is being finalized), the
      // same payment can be sent again soon.
      form.setError('root', {
        message:
          code === 'CONFLICT'
            ? 'This may already have been recorded from your last try. Check the balances before recording it again.'
            : (error as Error).message,
      })
    }
  })

  return (
    <form
      ref={ref}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (form.formState.isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <SelectField id="pay-from" label="From" error={errors.from} {...form.register('from')}>
        <option value="">Choose who paid</option>
        {people.map((member) => (
          <option key={member.$id} value={member.personId}>
            {member.displayName}
          </option>
        ))}
      </SelectField>
      <SelectField id="pay-to" label="To" error={errors.to} {...form.register('to')}>
        <option value="">Choose who was paid</option>
        {people.map((member) => (
          <option key={member.$id} value={member.personId}>
            {member.displayName}
          </option>
        ))}
      </SelectField>
      <TextField
        id="pay-amount"
        label={`Amount (${group.currency})`}
        inputMode="decimal"
        hint="Change it for a part payment."
        error={errors.amount}
        {...form.register('amount')}
      />
      <TextField
        id="pay-date"
        type="date"
        label="Date"
        error={errors.date}
        {...form.register('date')}
      />
      <TextField
        id="pay-description"
        label="Description"
        error={errors.description}
        {...form.register('description')}
      />
      <TextareaField
        id="pay-note"
        label="Note (optional)"
        error={errors.note}
        {...form.register('note')}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Record payment'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
