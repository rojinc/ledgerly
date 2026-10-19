import { CATEGORIES } from '@ledgerly/core/constants/categories'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { type ScheduleInput, scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { ID } from 'appwrite'
import { type ReactNode, useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { centsToText } from '../groups/employer-form'
import { WEEKDAY_LABEL, WEEKDAYS } from '../schedules/rrule'
import { Message, usePersonalGroup } from './bills-page'
import { type RecurringValues, toRecurringInput } from './recurring-values'
import { useCreateRecurringBill } from './use-bills'

/** Schema errors on the fields the form shows, in plain words. */
function recurringResolver(
  toBody: (values: RecurringValues) => ReturnType<typeof toRecurringInput>,
  currency: string,
): Resolver<RecurringValues, unknown, ScheduleInput> {
  const resolve = schemaResolver<RecurringValues, ScheduleInput>(scheduleInputSchema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof RecurringValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const total = toBody(values).template.totalCents
    if (values.amount.trim() === '') add('amount', 'Required')
    else if (get(found, 'template.totalCents') || Number.isNaN(total)) {
      add('amount', `Enter an amount like ${centsToText(4550, currency)}`)
    } else if (typeof total === 'number' && total <= 0) add('amount', 'Enter an amount above 0')
    if (values.repeat === 'monthly' && !/^([1-9]|1\d|2[0-8])$/.test(values.monthDay.trim())) {
      add('monthDay', 'Enter a day from 1 to 28, or choose the last day of the month')
    }
    if (!values.startsOn) add('startsOn', 'Required')
    if (values.until && values.startsOn && values.until < values.startsOn) {
      add('until', 'The last date must be on or after the first')
    }
    const fields: Record<string, keyof RecurringValues> = {
      description: 'description',
      'template.category': 'category',
      startsOn: 'startsOn',
    }
    for (const [path, field] of Object.entries(fields)) {
      const message = get(found, path)?.message as string | undefined
      if (message) add(field, message)
    }
    if (Object.keys(errors).length > 0)
      return { values: {}, errors: errors as FieldErrors<RecurringValues> }
    if (Object.keys(found).length > 0) {
      return {
        values: {},
        errors: { root: { type: 'validate', message: 'Something in the form is not valid.' } },
      }
    }
    return result
  }
}

/** `/bills/recurring/new`: a bill that repeats, in the personal group (#75). */
export function NewRecurringBillPage() {
  const personal = usePersonalGroup()
  let content: ReactNode
  if (personal.group) {
    content = <RecurringBillForm group={personal.group} />
  } else {
    content = personal.isError ? (
      <Message alert>We couldn’t load your bills. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New recurring bill</h1>
      {content}
    </div>
  )
}

function RecurringBillForm({ group }: { group: Groups }) {
  const navigate = useNavigate()
  const create = useCreateRecurringBill()
  // One ID per visit, so retrying after an error can't make the schedule twice.
  const [id] = useState(() => ID.unique())
  const toBody = (values: RecurringValues) =>
    toRecurringInput(values, { id, groupId: group.$id }, group.currency)
  const form = useForm<RecurringValues, unknown, ScheduleInput>({
    resolver: recurringResolver(toBody, group.currency),
    defaultValues: {
      description: '',
      category: '',
      amount: '',
      repeat: 'monthly',
      weekday: 'MO',
      monthDay: '1',
      startsOn: localToday(group.timezone, new Date()),
      until: '',
      autopay: false,
    },
  })
  const { errors, isSubmitting } = form.formState
  const repeat = form.watch('repeat')

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // Save stays focusable while saving (aria-disabled), so a second submit is ignored here.
        if (isSubmitting) {
          event.preventDefault()
          return
        }
        void form.handleSubmit(async (body) => {
          try {
            await create.mutateAsync(body)
            navigate('/bills', { replace: true })
          } catch (error) {
            form.setError('root', { message: (error as Error).message })
          }
        })(event)
      }}
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
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Repeats</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="weekly" {...form.register('repeat')} />
          Every week
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="monthly" {...form.register('repeat')} />
          Every month, on a day
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="last" {...form.register('repeat')} />
          On the last day of each month
        </label>
      </fieldset>
      {repeat === 'weekly' && (
        <SelectField id="weekday" label="On" {...form.register('weekday')}>
          {WEEKDAYS.map((day) => (
            <option key={day} value={day}>
              {WEEKDAY_LABEL[day]}
            </option>
          ))}
        </SelectField>
      )}
      {repeat === 'monthly' && (
        <TextField
          id="monthDay"
          inputMode="numeric"
          label="Day of the month"
          hint="1 to 28. For later days, choose the last day of each month."
          error={errors.monthDay}
          {...form.register('monthDay')}
        />
      )}
      <TextField
        id="startsOn"
        type="date"
        label="First due date"
        error={errors.startsOn}
        {...form.register('startsOn')}
      />
      <TextField
        id="until"
        type="date"
        label="Last due date (optional)"
        hint="Leave empty to keep it going."
        error={errors.until}
        {...form.register('until')}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register('autopay')} />
        Autopay: mark each one paid on its due date
      </label>
      <Button type="submit" className="self-start" aria-disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Add recurring bill'}
      </Button>
    </form>
  )
}
