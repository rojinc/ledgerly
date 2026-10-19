import { CATEGORIES } from '@ledgerly/core/constants/categories'
import type { Groups } from '@ledgerly/core/generated/rows'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { centsToText } from '../groups/employer-form'
import { type BillValues, toBillBody } from './bill-values'

type Props = {
  group: Groups
  id: string
  defaultValues: BillValues
  submitLabel: string
  /** A new bill can be added as already paid; an edit keeps a due bill due. */
  canMarkPaid: boolean
  onSave: (body: TransactionInput) => Promise<unknown>
}

/** Schema errors on the fields the form shows, in plain words. */
function billResolver(
  toBody: (values: BillValues) => ReturnType<typeof toBillBody>,
  currency: string,
): Resolver<BillValues, unknown, TransactionInput> {
  const resolve = schemaResolver<BillValues, TransactionInput>(transactionInputSchema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof BillValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const total = toBody(values).totalCents
    if (values.amount.trim() === '') add('amount', 'Required')
    else if (get(found, 'totalCents') || Number.isNaN(total)) {
      add('amount', `Enter an amount like ${centsToText(4550, currency)}`)
    } else if (typeof total === 'number' && total <= 0) add('amount', 'Enter an amount above 0')
    // The date the body carries is the due date, or the paid date.
    const dateField = values.paid ? 'paidOn' : 'dueOn'
    if (!values[dateField]) add(dateField, 'Required')
    const fields: Record<string, keyof BillValues> = {
      description: 'description',
      category: 'category',
      date: dateField,
      'bill.dueOn': 'dueOn',
    }
    for (const [path, field] of Object.entries(fields)) {
      const message = get(found, path)?.message as string | undefined
      if (message) add(field, message)
    }
    if (Object.keys(errors).length > 0)
      return { values: {}, errors: errors as FieldErrors<BillValues> }
    if (Object.keys(found).length > 0) {
      return {
        values: {},
        errors: { root: { type: 'validate', message: 'Something in the form is not valid.' } },
      }
    }
    return result
  }
}

/** A personal bill: new (due or already paid), or a due one's changes. */
export function BillForm({ group, id, defaultValues, submitLabel, canMarkPaid, onSave }: Props) {
  const toBody = (values: BillValues) =>
    toBillBody(values, { id, groupId: group.$id }, group.currency)
  const form = useForm<BillValues, unknown, TransactionInput>({
    resolver: billResolver(toBody, group.currency),
    defaultValues,
  })
  const { errors, isSubmitting } = form.formState
  const paid = form.watch('paid')

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={form.handleSubmit(async (body) => {
        try {
          await onSave(body)
        } catch (error) {
          form.setError('root', { message: (error as Error).message })
        }
      })}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id="description"
        label="Description"
        error={errors.description}
        {...form.register('description')}
      />
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
      <TextField
        id="amount"
        inputMode="decimal"
        label={`Amount (${group.currency})`}
        error={errors.amount}
        {...form.register('amount')}
      />
      {canMarkPaid && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('paid')} />
          Already paid
        </label>
      )}
      {paid ? (
        <TextField
          id="paidOn"
          type="date"
          label="Paid on"
          error={errors.paidOn}
          {...form.register('paidOn')}
        />
      ) : (
        <TextField
          id="dueOn"
          type="date"
          label="Due date"
          error={errors.dueOn}
          {...form.register('dueOn')}
        />
      )}
      <Button type="submit" className="self-start" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : submitLabel}
      </Button>
    </form>
  )
}
