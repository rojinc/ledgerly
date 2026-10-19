import { CATEGORIES } from '@ledgerly/core/constants/categories'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { amountError } from '../transactions/presets'
import { PaidByField } from '../transactions/split-fields'
import type { StoredExtras } from './bill-values'
import {
  defaultBillSplit,
  type HouseBillValues,
  type PreviewLine,
  previewHouseBill,
  toHouseBillBody,
} from './house-bill'

type Props = {
  group: Groups
  members: Members[]
  /** The viewer: the default payer, and who pays in a preview of an unpaid bill. */
  personId: string
  id: string
  defaultValues: HouseBillValues
  submitLabel: string
  /** A new bill can be added as already paid; an edit keeps a due bill due. */
  canMarkPaid: boolean
  /** A stored bill's parts the form doesn't show, sent back unchanged. */
  kept?: StoredExtras
  /** Inside a section with its own heading: the preview's heading goes a level down. */
  nested?: boolean
  onSave: (body: TransactionInput) => Promise<unknown>
}

type ToBody = (values: HouseBillValues) => ReturnType<typeof toHouseBillBody>
type Preview = ReturnType<typeof previewHouseBill>

// A refusal the preview already shows: the resolver blocks Save without saying it twice.
const PREVIEW_REFUSED = 'preview'

/** Schema errors on the fields the form shows, in plain words, then the preview's refusal. */
function houseBillResolver(
  toBody: ToBody,
  preview: (values: HouseBillValues) => Preview,
  currency: string,
): Resolver<HouseBillValues, unknown, TransactionInput> {
  const resolve = schemaResolver<HouseBillValues, TransactionInput>(transactionInputSchema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof HouseBillValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const body = toBody(values)
    const amount = amountError(
      values.amount,
      body.totalCents,
      Boolean(get(found, 'totalCents')),
      currency,
    )
    if (amount) add('amount', amount)
    if (!values.periodStart) add('periodStart', 'Required')
    if (!values.periodEnd) add('periodEnd', 'Required')
    // The date the body carries is the due date, or the paid date.
    const dateField = values.paid ? 'paidOn' : 'dueOn'
    if (!values[dateField]) add(dateField, 'Required')
    const fields: Record<string, keyof HouseBillValues> = {
      description: 'description',
      category: 'category',
      date: dateField,
      'bill.dueOn': 'dueOn',
      'bill.periodStart': 'periodStart',
      'bill.periodEnd': 'periodEnd',
    }
    for (const [path, field] of Object.entries(fields)) {
      const message = get(found, path)?.message as string | undefined
      if (message) add(field, message)
    }
    if (Object.keys(errors).length > 0) {
      return { values: {}, errors: errors as FieldErrors<HouseBillValues> }
    }
    const refused = preview(values)
    if (refused && 'error' in refused) {
      return { values: {}, errors: { root: { type: PREVIEW_REFUSED, message: refused.error } } }
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

/** A house bill (#44): new (due or already paid), or a due one's changes. */
export function HouseBillForm({
  group,
  members,
  personId,
  id,
  defaultValues,
  submitLabel,
  canMarkPaid,
  kept,
  nested = false,
  onSave,
}: Props) {
  // By name, as the house expense form lists them, for Paid by, the ticks and the preview.
  const people = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName))
  const toBody: ToBody = (values) =>
    toHouseBillBody(values, { id, groupId: group.$id }, group.currency, kept)
  const preview = (values: HouseBillValues) =>
    previewHouseBill(toBody(values), group, people, personId)
  const form = useForm<HouseBillValues, unknown, TransactionInput>({
    resolver: houseBillResolver(toBody, preview, group.currency),
    defaultValues,
  })
  const { errors, isSubmitting } = form.formState
  const values = form.watch()
  const shown = preview(values)
  const refused = Boolean(shown && 'error' in shown)
  const names = new Map(people.map((member) => [member.personId, member.displayName]))
  const splits: { value: HouseBillValues['split']; label: string }[] = [
    // Only where it's the house's default: naming no split means the default (ledger.md).
    ...(defaultBillSplit(group) === 'equal'
      ? [{ value: 'equal' as const, label: 'Everyone present, equally' }]
      : []),
    { value: 'days', label: 'Everyone, by days present' },
    { value: 'someDays', label: 'Only some people, by days present' },
  ]

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // Save stays focusable while saving (aria-disabled), so a second submit is ignored here.
        // A refused preview is blocked by the resolver.
        if (isSubmitting) {
          event.preventDefault()
          return
        }
        void form.handleSubmit(async (body) => {
          try {
            await onSave(body)
          } catch (error) {
            form.setError('root', { message: (error as Error).message })
          }
        })(event)
      }}
    >
      {errors.root && errors.root.type !== PREVIEW_REFUSED && (
        <Alert variant="destructive">{errors.root.message}</Alert>
      )}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="periodStart"
          type="date"
          label="Period starts"
          error={errors.periodStart}
          {...form.register('periodStart')}
        />
        <TextField
          id="periodEnd"
          type="date"
          label="Period ends"
          error={errors.periodEnd}
          {...form.register('periodEnd')}
        />
      </div>
      {canMarkPaid && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('paid')} />
          Already paid
        </label>
      )}
      {values.paid ? (
        <>
          <TextField
            id="paidOn"
            type="date"
            label="Paid on"
            error={errors.paidOn}
            {...form.register('paidOn')}
          />
          <PaidByField members={people} field={form.register('paidBy')} error={errors.paidBy} />
        </>
      ) : (
        <TextField
          id="dueOn"
          type="date"
          label="Due date"
          error={errors.dueOn}
          {...form.register('dueOn')}
        />
      )}
      {values.split === 'kept' ? (
        <p className="text-sm text-muted-foreground">
          This bill’s split can’t be changed here, so it stays as it is.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Split</legend>
          {splits.map((split) => (
            <label key={split.value} className="flex items-center gap-2 text-sm">
              <input type="radio" value={split.value} {...form.register('split')} />
              {split.label}
            </label>
          ))}
          {values.split === 'someDays' && (
            <fieldset className="ml-6 flex flex-col gap-2">
              <legend className="sr-only">People to split it between</legend>
              {people.map((member) => (
                <label key={member.personId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    value={member.personId}
                    {...form.register('splitPeople')}
                  />
                  <span className="min-w-0 break-words">{member.displayName}</span>
                </label>
              ))}
            </fieldset>
          )}
        </fieldset>
      )}
      {/* Mounted from the start, so a refusal is read out when it appears. */}
      <p role="status" className="text-sm text-destructive empty:hidden">
        {shown && 'error' in shown ? shown.error : ''}
      </p>
      {shown && 'lines' in shown && (
        <PreviewList lines={shown.lines} names={names} currency={group.currency} nested={nested} />
      )}
      {/* aria-disabled, not disabled: a disabled button loses focus. */}
      <Button type="submit" className="self-start" aria-disabled={isSubmitting || refused}>
        {isSubmitting ? 'Saving…' : submitLabel}
      </Button>
    </form>
  )
}

/** Each person's days in the period and their part, in words: never colour alone. */
function PreviewList({
  lines,
  names,
  currency,
  nested,
}: {
  lines: PreviewLine[]
  names: Map<string, string>
  currency: string
  nested: boolean
}) {
  const Heading = nested ? 'h3' : 'h2'
  return (
    <section aria-labelledby="bill-preview" className="flex flex-col gap-1">
      <Heading id="bill-preview" className="text-sm font-medium">
        Each person’s part
      </Heading>
      <ul className="flex flex-col gap-1 text-sm">
        {lines.map((line) => (
          <li key={line.personId} className="break-words">
            {names.get(line.personId) ?? 'Someone'}:{' '}
            {line.days === 0
              ? 'Not here in this period'
              : `${line.days} ${line.days === 1 ? 'day' : 'days'}, ${formatMoney(line.shareCents, currency)}`}
          </li>
        ))}
      </ul>
    </section>
  )
}
