import type { Groups } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { shiftAmountCents } from '@ledgerly/core/money/shift-amount'
import { type TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { paidMinutes, parseHours, type ShiftValues, toShiftBody } from './shift-values'

type Props = {
  /** The groups a shift can go in: one, when editing. */
  groups: Groups[]
  id: string
  defaultValues: ShiftValues
  submitLabel: string
  /** The group's default rate as text, for a new shift whose group changes. */
  rateFor: (group: Groups) => string
  onSave: (body: TransactionInput) => Promise<unknown>
}

const ERROR_FIELD: Record<string, keyof ShiftValues> = {
  groupId: 'groupId',
  date: 'date',
  description: 'description',
  'shift.rateCents': 'rate',
  'shift.breakMinutes': 'breakMinutes',
  'shift.startTime': 'startTime',
  'shift.endTime': 'endTime',
}

/** Schema errors on the fields the form shows, in plain words. */
function shiftResolver(
  currencyOf: (groupId: string) => string,
  id: string,
): Resolver<ShiftValues, unknown, TransactionInput> {
  return async (values, context, options) => {
    const currency = currencyOf(values.groupId)
    const resolve = schemaResolver<ShiftValues, TransactionInput>(transactionInputSchema, (v) =>
      toShiftBody(v, id, currency),
    )
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof ShiftValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    if (values.timing === 'times') {
      if (!values.startTime) add('startTime', 'Required')
      if (!values.endTime) add('endTime', 'Required')
      const breakText = values.breakMinutes.trim()
      if (breakText !== '' && !/^\d+$/.test(breakText)) add('breakMinutes', 'Enter whole minutes')
      if (
        values.startTime &&
        values.endTime &&
        /^\d*$/.test(breakText) &&
        paidMinutes(values) < 0
      ) {
        add('breakMinutes', 'The break is longer than the shift')
      }
    } else if (parseHours(values.hours) === undefined) {
      add('hours', values.hours.trim() === '' ? 'Required' : 'Enter hours like 7.5 or 7:30')
    } else if ((parseHours(values.hours) as number) > 24 * 60) {
      add('hours', 'At most 24 hours')
    }
    if (values.rate.trim() === '') add('rate', 'Required')
    else if (get(found, 'shift.rateCents')) add('rate', 'Enter an amount like 25.50')
    for (const [path, field] of Object.entries(ERROR_FIELD)) {
      const message = get(found, path)?.message as string | undefined
      if (message) add(field, message)
    }
    // The pay cap is checked on the whole shift.
    if (get(found, 'shift') && Object.keys(errors).length === 0)
      add('rate', 'This shift pays too much')
    if (Object.keys(found).length > 0 && Object.keys(errors).length === 0) {
      return {
        values: {},
        errors: { root: { type: 'validate', message: 'Something in the form is not valid.' } },
      }
    }
    if (Object.keys(errors).length === 0) return result
    return { values: {}, errors: errors as FieldErrors<ShiftValues> }
  }
}

export function ShiftForm({ groups, id, defaultValues, submitLabel, rateFor, onSave }: Props) {
  const byId = new Map(groups.map((group) => [group.$id, group]))
  const currencyOf = (groupId: string) => byId.get(groupId)?.currency ?? 'AUD'
  const form = useForm<ShiftValues, unknown, TransactionInput>({
    resolver: shiftResolver(currencyOf, id),
    defaultValues,
  })
  const { errors, isSubmitting, isSubmitSuccessful, isDirty } = form.formState
  const values = form.watch()
  const minutes = paidMinutes(values)
  const currency = currencyOf(values.groupId)
  let pay: string | undefined
  try {
    const { shift } = toShiftBody(values, id, currency)
    if (shift && Number.isInteger(shift.minutes) && shift.minutes >= 0) {
      pay = formatMoney(shiftAmountCents(shift.minutes, shift.rateCents), currency)
    }
  } catch {
    pay = undefined
  }

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (body) => {
        try {
          await onSave(body)
          form.reset(form.getValues())
        } catch (error) {
          form.setError('root', { message: (error as Error).message })
        }
      })}
      className="flex flex-col gap-4"
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      {groups.length > 1 && (
        <SelectField
          id="groupId"
          label="Employer"
          error={errors.groupId}
          {...form.register('groupId', {
            onChange: (event) => {
              const group = byId.get(event.target.value)
              if (group && !form.getFieldState('rate').isDirty)
                form.setValue('rate', rateFor(group))
            },
          })}
        >
          {groups.map((group) => (
            <option key={group.$id} value={group.$id}>
              {group.name}
            </option>
          ))}
        </SelectField>
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
        label="Description"
        error={errors.description}
        {...form.register('description')}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Time worked</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" value="times" {...form.register('timing')} />
            Start and end
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" value="hours" {...form.register('timing')} />
            Hours
          </label>
        </div>
      </fieldset>
      {values.timing === 'times' ? (
        <div className="grid grid-cols-2 gap-3">
          <TextField
            id="startTime"
            type="time"
            label="Start"
            error={errors.startTime}
            {...form.register('startTime')}
          />
          <TextField
            id="endTime"
            type="time"
            label="End"
            hint="Before the start means the next day."
            error={errors.endTime}
            {...form.register('endTime')}
          />
          <TextField
            id="breakMinutes"
            inputMode="numeric"
            label="Break (minutes)"
            error={errors.breakMinutes}
            {...form.register('breakMinutes')}
          />
        </div>
      ) : (
        <TextField
          id="hours"
          inputMode="decimal"
          label="Hours worked"
          hint="After breaks, like 7.5 or 7:30."
          error={errors.hours}
          {...form.register('hours')}
        />
      )}
      <TextField
        id="rate"
        inputMode="decimal"
        label={`Hourly rate (${currency})`}
        error={errors.rate}
        {...form.register('rate')}
      />
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {pay !== undefined && Number.isInteger(minutes)
          ? `${Math.floor(minutes / 60)} h ${minutes % 60} min paid · ${pay}`
          : ' '}
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
        {isSubmitSuccessful && !isDirty && !errors.root && (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        )}
      </div>
    </form>
  )
}
