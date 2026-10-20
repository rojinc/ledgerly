import { CATEGORIES } from '@ledgerly/core/constants/categories'
import { addDays, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { type ScheduleInput, scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { ID } from 'appwrite'
import { type ReactNode, useState } from 'react'
import { type FieldError, type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { useNavigate, useSearchParams } from 'react-router'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { centsToText } from '../groups/employer-form'
import { WEEKDAY_LABEL, WEEKDAYS } from '../schedules/rrule'
import { BACKDATE_DAYS } from '../schedules/schedule-form-page'
import { formatDate } from '../statements/invoice-view'
import { defaultTicks } from '../transactions/house-expense'
import { PaidByField, SplitBetweenField } from '../transactions/split-fields'
import { useMembers } from '../transactions/use-transactions'
import { Message, useHouse, usePersonalGroup } from './bills-page'
import { type RecurringValues, toRecurringInput } from './recurring-values'
import { useCreateRecurringBill } from './use-bills'

/** Schema errors on the fields the form shows, in plain words. */
function recurringResolver(
  toBody: (values: RecurringValues) => ReturnType<typeof toRecurringInput>,
  currency: string,
  /** The earliest first date: see `earliestStart()`. */
  minStartOf: (values: RecurringValues) => LocalDate,
  /** A house's form, which names who it's split between. */
  house: boolean,
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
    if (values.repeat === 'monthly' && !/^(0?[1-9]|1\d|2[0-8])$/.test(values.monthDay.trim())) {
      add('monthDay', 'Enter a day from 1 to 28, or choose the last day of the month')
    }
    const minStart = minStartOf(values)
    if (!values.startsOn) add('startsOn', 'Required')
    else if (values.startsOn < minStart)
      add('startsOn', `Pick a date from ${formatDate(minStart)} on`)
    if (house && values.split === 'ticked' && values.splitBetween.length === 0) {
      add('splitBetween', 'Tick at least one person')
    }
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

/**
 * The earliest first date. The scheduler refuses a start more than BACKDATE_DAYS ago. A recurring
 * expense starts today at the earliest: past occurrences are never posted by themselves
 * (scheduling.md#step-2-auto-post), and nothing in the app posts a `scheduled` expense.
 */
function earliestStart(today: LocalDate, values: RecurringValues, house: boolean): LocalDate {
  return house && values.kind === 'expense' ? today : addDays(today, -BACKDATE_DAYS)
}

/**
 * `/bills/recurring/new`: a bill that repeats, in the personal group (#75), or with `?groupId=` a
 * house's bill or expense (#403).
 */
export function NewRecurringBillPage() {
  const groupId = useSearchParams()[0].get('groupId')
  return groupId ? <NewRecurringHousePage groupId={groupId} /> : <NewRecurringPersonalPage />
}

function NewRecurringPersonalPage() {
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

/** A house's recurring bill or expense (#403): admins and members add them, as one-off bills. */
function NewRecurringHousePage({ groupId }: { groupId: string }) {
  const { house, personId, canAdd, roleKnown } = useHouse(groupId)
  const members = useMembers(groupId)
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
    content = <RecurringBillForm group={house} house={{ members: members.data, personId }} />
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold break-words">
        {house ? `New recurring bill or expense · ${house.name}` : 'New recurring bill or expense'}
      </h1>
      {content}
    </div>
  )
}

function RecurringBillForm({
  group,
  house,
}: {
  group: Groups
  /** A house's form: its members, and the caller, who pays by default. */
  house?: { members: Members[]; personId: string }
}) {
  const navigate = useNavigate()
  const create = useCreateRecurringBill()
  // One ID per visit, so retrying after an error can't make the schedule twice.
  const [id] = useState(() => ID.unique())
  const toBody = (values: RecurringValues) =>
    toRecurringInput(values, { id, groupId: group.$id }, group.currency, house !== undefined)
  const today = localToday(group.timezone, new Date())
  const minStartOf = (values: RecurringValues) => earliestStart(today, values, house !== undefined)
  const sorted = [...(house?.members ?? [])].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )
  const form = useForm<RecurringValues, unknown, ScheduleInput>({
    resolver: recurringResolver(toBody, group.currency, minStartOf, house !== undefined),
    defaultValues: {
      description: '',
      category: '',
      amount: '',
      repeat: 'monthly',
      weekday: 'MO',
      monthDay: '1',
      startsOn: today,
      until: '',
      autopay: false,
      kind: 'bill',
      paidBy: house?.personId ?? '',
      split: 'everyone',
      splitBetween: house ? defaultTicks(house.members, today) : [],
    },
  })
  const { errors, isSubmitting } = form.formState
  const repeat = form.watch('repeat')
  const expense = house !== undefined && form.watch('kind') === 'expense'
  const split = form.watch('split')
  const startsOn = form.watch('startsOn')
  const minStart = minStartOf(form.watch())

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
            // The Bills heading takes focus there, as this form and its button are gone.
            navigate(house ? `/bills?groupId=${group.$id}` : '/bills', {
              replace: true,
              state: { saved: true },
            })
          } catch (error) {
            form.setError('root', { message: (error as Error).message })
          }
        })(event)
      }}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      {house && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">What is it?</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" value="bill" className="mt-1" {...form.register('kind')} />
            <span>
              <span className="block font-medium">A bill</span>
              <span className="block text-muted-foreground">
                Due on each date, until someone marks it paid. For example rent or internet.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" value="expense" className="mt-1" {...form.register('kind')} />
            <span>
              <span className="block font-medium">An expense</span>
              <span className="block text-muted-foreground">
                Added on each date, as already paid. For example a cleaner paid by direct debit.
              </span>
            </span>
          </label>
        </fieldset>
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
      {house && (
        <>
          <PaidByField members={sorted} field={form.register('paidBy')} error={errors.paidBy} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Split it equally between</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" value="everyone" {...form.register('split')} />
              Everyone living here on each date
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" value="ticked" {...form.register('split')} />
              Only the people I tick
            </label>
          </fieldset>
          {split === 'ticked' && (
            <SplitBetweenField
              members={sorted}
              date={startsOn}
              legend="Who it’s split between"
              field={form.register('splitBetween')}
              error={errors.splitBetween as FieldError | undefined}
            />
          )}
        </>
      )}
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
        <SelectField id="weekday" label="Day of the week" {...form.register('weekday')}>
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
        label={expense ? 'First date' : 'First due date'}
        hint={
          expense
            ? 'The first one is added on the first matching day from this date, today at the earliest.'
            : 'The first bill is due on the first matching day from this date.'
        }
        min={minStart}
        error={errors.startsOn}
        {...form.register('startsOn')}
      />
      <TextField
        id="until"
        type="date"
        label={expense ? 'Last date (optional)' : 'Last due date (optional)'}
        hint="Leave empty to keep it going."
        error={errors.until}
        {...form.register('until')}
      />
      {!expense && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" aria-describedby="autopay-hint" {...form.register('autopay')} />
            Autopay: mark each one paid on its due date
          </label>
          <p id="autopay-hint" className="text-sm text-muted-foreground">
            Without autopay, each bill shows as due until {house ? 'someone marks' : 'you mark'} it
            paid.
          </p>
        </div>
      )}
      <Button type="submit" className="self-start" aria-disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : expense ? 'Add recurring expense' : 'Add recurring bill'}
      </Button>
    </form>
  )
}
