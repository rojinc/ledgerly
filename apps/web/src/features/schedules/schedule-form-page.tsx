import { addDays, isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Schedules } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { shiftAmountCents } from '@ledgerly/core/money/shift-amount'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { type ScheduleInput, scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { ID } from 'appwrite'
import { type ReactNode, useRef, useState } from 'react'
import { type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, SelectField, TextField } from '../../ui/field'
import { Input } from '../../ui/input'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { centsToText } from '../groups/employer-form'
import { useGroups, useMyMember } from '../groups/use-groups'
import { parseHours } from '../shifts/shift-values'
import { WEEKDAY_LABEL, WEEKDAYS } from './rrule'
import { fromSchedule, keptOf, type ScheduleValues, toScheduleInput } from './schedule-values'
import { formatDate } from './schedules-page'
import { usePreview, useSaveSchedule, useSchedule } from './use-schedules'

// scheduling.md: 1–28, so every month has the day; the last day is its own option.
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

// The input's fields, as the form names them.
const ERROR_FIELD: Record<string, keyof ScheduleValues> = {
  description: 'description',
  startsOn: 'startsOn',
  'template.shift.rateCents': 'rate',
}

// `exdates`' limit in `scheduleInputSchema`, past dates included.
const MAX_SKIPPED = 366

/** How far back a new schedule may start: its dates from then to yesterday are created too. */
export const BACKDATE_DAYS = 31

/**
 * Schema errors on the fields the form shows, in plain words. `minStart`: the earliest start a
 * new schedule may have (#137 review: a mistyped year would create years of past shifts).
 */
function scheduleResolver(
  toInput: (values: ScheduleValues) => ReturnType<typeof toScheduleInput>,
  minStart: LocalDate | undefined,
): Resolver<ScheduleValues, unknown, ScheduleInput> {
  const resolve = schemaResolver<ScheduleValues, ScheduleInput>(scheduleInputSchema, toInput)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof ScheduleValues, message: string) => {
      if (!errors[field]) errors[field] = { type: 'validate', message }
    }
    const minutes = parseHours(values.hours)
    if (values.hours.trim() === '') add('hours', 'Required')
    else if (minutes === undefined) add('hours', 'Enter hours like 5, 7.5 or 7:30')
    else if (minutes === 0) add('hours', 'Enter more than 0 hours')
    else if (minutes > 24 * 60) add('hours', 'At most 24 hours a shift')
    if (values.rate.trim() === '') add('rate', 'Required')
    else if (get(found, 'template.shift.rateCents')) add('rate', 'Enter an amount like 25.50')
    if (values.pattern === 'weekly' && values.days.length === 0)
      add('days', 'Pick at least one day')
    const count = values.count.trim()
    if (
      values.end === 'count' &&
      !(/^\d{1,3}$/.test(count) && Number(count) >= 1 && Number(count) <= 500)
    ) {
      add('count', 'Enter a number from 1 to 500')
    }
    if (values.end === 'until' && values.until === '') add('until', 'Required')
    if (minStart && values.startsOn !== '' && values.startsOn < minStart) {
      add('startsOn', `Pick a date from ${formatDate(minStart)} on`)
    }
    // The rule's own error, in plain words, only when the days, count or last date haven't
    // said what's wrong already: an empty BYDAY isn't news after "Pick at least one day".
    const ruleError = get(found, 'rrule')?.message as string | undefined
    if (ruleError && !errors.days && !errors.count && !errors.until) {
      if (values.end === 'until' && /UNTIL/.test(ruleError)) {
        add('until', 'Must be on or after the start date')
      } else {
        errors.root = { type: 'validate', message: 'Check how often it repeats and when it ends.' }
      }
    }
    // A kept end date (this form doesn't show it) before a new start.
    if (get(found, 'endsOn')) add('startsOn', 'Must be on or before the schedule’s end date')
    for (const [path, field] of Object.entries(ERROR_FIELD)) {
      const message = get(found, path)?.message as string | undefined
      if (message) add(field, message)
    }
    if (Object.keys(errors).length > 0) {
      return { values: {}, errors: errors as FieldErrors<ScheduleValues> }
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

function defaultRate(group: Groups): string {
  try {
    const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
    return settings.type === 'employer'
      ? centsToText(settings.defaultRateCents, group.currency)
      : ''
  } catch {
    return ''
  }
}

/** `/schedules/new?groupId=`: a new shift schedule in an employer group (#30). */
export function NewSchedulePage() {
  const [params] = useSearchParams()
  const [id] = useState(() => ID.unique())
  return (
    <ScheduleFormPage
      title="New schedule"
      groupId={params.get('groupId') ?? ''}
      id={id}
      schedule={undefined}
    />
  )
}

/** `/schedules/{id}`: change a shift schedule (#30). */
export function EditSchedulePage() {
  const id = useParams().scheduleId ?? ''
  const schedule = useSchedule(id)
  if (!schedule.data) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Schedule</h1>
        {schedule.isError ? (
          <Message alert>We couldn’t load this schedule. Reload the page to try again.</Message>
        ) : (
          <Message>Loading…</Message>
        )}
      </div>
    )
  }
  return (
    <ScheduleFormPage
      title={schedule.data.description}
      groupId={schedule.data.groupId}
      id={id}
      schedule={schedule.data}
    />
  )
}

function ScheduleFormPage({
  title,
  groupId,
  id,
  schedule,
}: {
  title: string
  groupId: string
  id: string
  schedule: Schedules | undefined
}) {
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const personId = bootstrap.data?.personId ?? ''
  const groups = useGroups()
  const group = groups.data?.find((g) => g.$id === groupId && g.type === 'employer')
  const member = useMyMember(groupId, personId)

  let content: ReactNode
  if (!groups.data || (group && member.data === undefined)) {
    content =
      (groups.isError && !groups.data) || member.isError || bootstrap.isError ? (
        <Message alert>We couldn’t load this group. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (!group) {
    content = (
      <Message>
        Pick an employer from{' '}
        <Link to="/schedules" className="underline underline-offset-4">
          Schedules
        </Link>{' '}
        first.
      </Message>
    )
  } else if (group.archivedAt) {
    content = <Message>{ARCHIVED_NOTICE}</Message>
  } else if (
    // functions-api.md#scheduler: an admin creates; the creator or an admin changes. A viewer
    // changes nothing, even one they made (permissions.md#roles).
    !(
      member.data?.role === 'admin' ||
      (member.data?.role === 'member' && schedule && schedule.createdBy === personId)
    )
  ) {
    content = (
      <Message>
        {schedule
          ? 'Only an admin, or the member who set it up, can change this schedule.'
          : 'Only an admin can set up schedules in this group.'}
      </Message>
    )
  } else {
    const stored = schedule && fromSchedule(schedule, group.currency)
    content =
      schedule && !stored ? (
        <Message>
          This schedule was set up in a way this page can’t show, so it can’t be changed here.
        </Message>
      ) : (
        <ScheduleForm
          group={group}
          id={id}
          schedule={schedule}
          defaultValues={
            stored ?? {
              pattern: 'weekly',
              days: [],
              interval: 1,
              monthDay: 1,
              end: 'never',
              count: '',
              until: '',
              description: 'Shift',
              hours: '',
              rate: defaultRate(group),
              startsOn: localToday(group.timezone, new Date()),
              skipPublicHolidays: false,
              autoPost: false,
              skipped: [],
            }
          }
        />
      )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold break-words">{title}</h1>
      {content}
    </div>
  )
}

function ScheduleForm({
  group,
  id,
  schedule,
  defaultValues,
}: {
  group: Groups
  id: string
  schedule: Schedules | undefined
  defaultValues: ScheduleValues
}) {
  const navigate = useNavigate()
  const save = useSaveSchedule(schedule === undefined)
  const kept = schedule ? keptOf(schedule) : {}
  const toInput = (values: ScheduleValues) =>
    toScheduleInput(values, { id, groupId: group.$id }, group.currency, kept)
  const [today] = useState(() => localToday(group.timezone, new Date()))
  // A new schedule starts at most BACKDATE_DAYS ago; an edit keeps its start.
  const minStart = schedule ? undefined : addDays(today, -BACKDATE_DAYS)
  const form = useForm<ScheduleValues, unknown, ScheduleInput>({
    resolver: scheduleResolver(toInput, minStart),
    defaultValues,
  })
  const { errors, isSubmitting } = form.formState
  const values = form.watch()
  const { id: _, ...preview } = toInput(values)
  const minutes = parseHours(values.hours)

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <form
        noValidate
        className="flex flex-1 flex-col gap-4"
        onSubmit={(event) => {
          // Save stays focusable while saving (aria-disabled), so a second submit is ignored here.
          if (isSubmitting) {
            event.preventDefault()
            return
          }
          void form.handleSubmit(async (input) => {
            try {
              await save.mutateAsync(input)
              // The list's heading takes focus: this form, and its button, are gone.
              navigate(`/schedules?groupId=${group.$id}`, { state: { saved: true } })
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
        <div className="grid grid-cols-2 gap-3">
          <TextField
            id="hours"
            inputMode="decimal"
            label="Paid hours per shift"
            hint="After breaks, like 5 or 7:30."
            error={errors.hours}
            {...form.register('hours')}
          />
          <TextField
            id="rate"
            inputMode="decimal"
            label={`Hourly rate (${group.currency})`}
            error={errors.rate}
            {...form.register('rate')}
          />
        </div>
        <SelectField id="pattern" label="Repeats" {...form.register('pattern')}>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </SelectField>
        {values.pattern === 'weekly' ? (
          <>
            <fieldset
              className="flex flex-col gap-2"
              aria-describedby={errors.days ? 'days-error' : undefined}
            >
              <legend className="mb-1 text-sm font-medium">On</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {WEEKDAYS.map((day) => (
                  <label key={day} className="flex items-center gap-2">
                    <input type="checkbox" value={day} {...form.register('days')} />
                    {WEEKDAY_LABEL[day]}
                  </label>
                ))}
              </div>
              {errors.days && (
                <p id="days-error" className="text-sm text-destructive">
                  {errors.days.message}
                </p>
              )}
            </fieldset>
            <SelectField
              id="interval"
              label="Every"
              {...form.register('interval', { valueAsNumber: true })}
            >
              <option value={1}>Week</option>
              <option value={2}>2 weeks</option>
              <option value={3}>3 weeks</option>
              <option value={4}>4 weeks</option>
            </SelectField>
          </>
        ) : (
          <SelectField
            id="monthDay"
            label="On day"
            {...form.register('monthDay', { valueAsNumber: true })}
          >
            {MONTH_DAYS.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
            <option value={-1}>The last day</option>
          </SelectField>
        )}
        <TextField
          id="startsOn"
          type="date"
          label="Starts on"
          hint={
            values.pattern === 'weekly' && values.interval > 1
              ? `Every ${values.interval === 2 ? 'other week' : `${values.interval} weeks`} counts from this week.`
              : undefined
          }
          min={minStart}
          error={errors.startsOn}
          {...form.register('startsOn')}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Ends</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="never" {...form.register('end')} />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="count" {...form.register('end')} />
            After a number of shifts
          </label>
          {values.end === 'count' && (
            <TextField
              id="count"
              inputMode="numeric"
              label="Number of shifts"
              error={errors.count}
              {...form.register('count')}
            />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="until" {...form.register('end')} />
            On a date
          </label>
          {values.end === 'until' && (
            <TextField
              id="until"
              type="date"
              label="Last date"
              error={errors.until}
              {...form.register('until')}
            />
          )}
        </fieldset>
        <SkippedDates
          skipped={values.skipped}
          today={today}
          // From the later of the start and today, to the earlier of the rule's last date and a
          // kept end date, if there's either.
          from={values.startsOn > today ? values.startsOn : today}
          last={
            [values.end === 'until' ? values.until : '', schedule?.endsOn ?? '']
              .filter((date) => date !== '')
              .sort()[0]
          }
          editing={schedule !== undefined}
          onChange={(skipped) => form.setValue('skipped', skipped, { shouldDirty: true })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('skipPublicHolidays')} />
          Skip public holidays ({group.region ?? 'the group’s region'})
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('autoPost')} />
          Confirm each shift automatically once the day is over
        </label>
        <p className="text-sm text-muted-foreground">
          {minutes !== undefined && minutes > 0
            ? `Each shift: ${Math.floor(minutes / 60)} h ${minutes % 60} min`
            : ' '}
        </p>
        <Button type="submit" className="self-start" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : schedule ? 'Save' : 'Create schedule'}
        </Button>
      </form>
      <PreviewPanel
        body={{ ...preview, count: 10 }}
        currency={group.currency}
        // A new schedule creates its past dates too, from the start to yesterday. An edit
        // doesn't recreate them.
        backdatedFrom={
          !schedule && values.startsOn !== '' && values.startsOn < today
            ? values.startsOn
            : undefined
        }
      />
    </div>
  )
}

/**
 * The dates the schedule skips (#487): those from today on, each with Remove, and a date to add.
 * Past ones aren't listed: they're kept as stored, since they change nothing.
 */
function SkippedDates({
  skipped,
  today,
  from,
  last,
  editing,
  onChange,
}: {
  skipped: string[]
  today: LocalDate
  from: string
  last: string | undefined
  editing: boolean
  onChange: (skipped: string[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [date, setDate] = useState('')
  const [refused, setRefused] = useState<string>()
  // Read out on each add, remove or refusal: focus stays on the button.
  const [said, setSaid] = useState('')
  const listed = skipped.filter((day) => day >= today).sort()
  // The API's limit counts every date, past ones too.
  const full = skipped.length >= MAX_SKIPPED

  const add = () => {
    if (full) return
    const reason =
      last !== undefined && last < from
        ? 'This schedule has no dates left to skip.'
        : !isLocalDate(date)
          ? 'Pick a date.'
          : date < from
            ? `Pick a date from ${formatDate(from)} on.`
            : last !== undefined && date > last
              ? `Pick a date on or before ${formatDate(last)}.`
              : skipped.includes(date)
                ? `${formatDate(date)} is already skipped.`
                : undefined
    setRefused(reason)
    if (reason) {
      setSaid(reason)
      return
    }
    onChange([...skipped, date].sort())
    setSaid(`${formatDate(date)} is skipped.`)
    setDate('')
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Skipped dates</legend>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <Field
        id="skipDate"
        label="Date to skip"
        hint={full ? `At most ${MAX_SKIPPED} dates can be skipped.` : undefined}
        error={refused ? { type: 'validate', message: refused } : undefined}
      >
        {(aria) => (
          // The input and its button on one line, with the hint and any reason under both.
          <div className="flex gap-2">
            <Input
              ref={input}
              type="date"
              min={from}
              max={last}
              value={date}
              onChange={(event) => {
                setDate(event.target.value)
                setRefused(undefined)
              }}
              onKeyDown={(event) => {
                // Enter skips the date, rather than saving the whole schedule.
                if (event.key !== 'Enter') return
                event.preventDefault()
                add()
              }}
              {...aria}
            />
            {/* aria-disabled, not disabled: a disabled button loses focus. */}
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              aria-disabled={full}
              aria-describedby={full ? 'skipDate-hint' : undefined}
              onClick={add}
            >
              Skip this date
            </Button>
          </div>
        )}
      </Field>
      {listed.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {listed.map((day) => (
            <li key={day} className="flex items-center justify-between gap-3">
              <span>{formatDate(day)}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Remove ${formatDate(day)}`}
                onClick={() => {
                  onChange(skipped.filter((other) => other !== day))
                  setSaid(`${formatDate(day)} is no longer skipped.`)
                  // This button goes with its date: the input is always there to take focus.
                  input.current?.focus()
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <p className="text-sm text-muted-foreground">
          Saving removes the planned shift on a newly skipped day, unless it’s been edited or
          confirmed, and brings back the shift on a day you remove, from today on.
        </p>
      )}
    </fieldset>
  )
}

/** The next dates, from `/schedules/preview`, and the ones it skips and why. */
function PreviewPanel({
  body,
  currency,
  backdatedFrom,
}: {
  body: Parameters<typeof usePreview>[0]
  currency: string
  backdatedFrom?: string
}) {
  const preview = usePreview(body)
  const shift = body?.template.shift
  let amount: string | undefined
  try {
    // Rounded as the ledger rounds it (ledger.md#allocation-and-rounding).
    if (shift && Number.isInteger(shift.minutes) && Number.isInteger(shift.rateCents)) {
      amount = formatMoney(shiftAmountCents(shift.minutes, shift.rateCents), currency)
    }
  } catch {
    amount = undefined
  }
  return (
    <section
      aria-labelledby="preview-heading"
      className="flex flex-col gap-2 rounded-md border border-border p-4 lg:w-72"
    >
      <h2 id="preview-heading" className="font-medium">
        Next shifts
      </h2>
      {/* Read out briefly on each change, not the whole list again. */}
      <p className="sr-only" aria-live="polite">
        {preview.data
          ? `${preview.data.dates.length} dates, ${preview.data.skipped.length} skipped`
          : ''}
      </p>
      {!preview.data ? (
        <p className="text-sm text-muted-foreground">
          {preview.isError
            ? preview.error.message
            : preview.isFetching
              ? 'Working out the dates…'
              : 'Fill in the form to see the dates.'}
        </p>
      ) : preview.data.dates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {/COUNT|UNTIL/.test(body?.rrule ?? '')
            ? 'No more dates.'
            : 'No dates: it never falls on a day it can.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {preview.data.dates.map((date) => (
            <li key={date} className="flex justify-between gap-3">
              <span>{formatDate(date)}</span>
              {amount && <span className="tabular-nums">{amount}</span>}
            </li>
          ))}
        </ul>
      )}
      {preview.data && preview.data.skipped.length > 0 && (
        <>
          <h3 className="text-sm font-medium">Skipped</h3>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {preview.data.skipped.map(({ date, reason }) => (
              <li key={date}>
                {formatDate(date)}: {reason === 'holiday' ? 'public holiday' : 'a day you skipped'}
              </li>
            ))}
          </ul>
        </>
      )}
      {backdatedFrom && (
        <p className="text-sm">
          Dates from {formatDate(backdatedFrom)} to yesterday are created too. They wait for you to
          confirm them.
        </p>
      )}
      {preview.isError && preview.data && (
        <p role="alert" className="text-sm text-destructive">
          {preview.error.message}
        </p>
      )}
    </section>
  )
}
