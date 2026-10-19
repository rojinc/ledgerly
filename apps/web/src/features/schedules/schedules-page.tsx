import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Schedules } from '@ledgerly/core/generated/rows'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { useGroups, useMyMember } from '../groups/use-groups'
import { describeRepeat, fromRrule } from './rrule'
import { useEndSchedule, useSchedules } from './use-schedules'

/**
 * A local date as `Thu 22 Oct 2026`. Built from its parts in UTC, so the browser's time zone
 * never moves it (scheduling.md#expanding-occurrences).
 */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
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

/** `/schedules?groupId=`: an employer group's shift schedules, to add, change or end (#30). */
export function SchedulesPage() {
  const groups = useGroups()
  const [params, setParams] = useSearchParams()
  const employers = groups.data?.filter((group) => group.type === 'employer')
  const group = employers?.find((g) => g.$id === params.get('groupId')) ?? employers?.[0]
  // Back from saving a schedule: its form, and the button that sent it, are gone (#137 review).
  const heading = useRef<HTMLHeadingElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (!(location.state as { saved?: boolean } | null)?.saved) return
    heading.current?.focus()
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [location.state, location.pathname, location.search, navigate])

  let content: ReactNode
  if (!employers) {
    content =
      groups.isError && !groups.data ? (
        <Message alert>We couldn’t load your groups. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (!group) {
    content = (
      <Message>
        Add an employer first:{' '}
        <Link to="/groups/new-employer" className="underline underline-offset-4">
          New employer
        </Link>
      </Message>
    )
  } else {
    content = (
      <>
        {employers.length > 1 && (
          <SelectField
            id="schedulesGroup"
            label="Employer"
            value={group.$id}
            onChange={(event) => setParams({ groupId: event.target.value }, { replace: true })}
          >
            {employers.map((g) => (
              <option key={g.$id} value={g.$id}>
                {g.name}
                {g.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </SelectField>
        )}
        <GroupSchedules group={group} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        Schedules
      </h1>
      {content}
    </div>
  )
}

function GroupSchedules({ group }: { group: Groups }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const member = useMyMember(group.$id, personId)
  const schedules = useSchedules(group.$id)
  const role = member.data?.role
  const isAdmin = role === 'admin'
  const today = localToday(group.timezone, new Date())
  // Focus lands here when a row's End goes away with its form.
  const heading = useRef<HTMLHeadingElement>(null)

  if (!schedules.data) {
    return schedules.isError ? (
      <Message alert>We couldn’t load the schedules. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  return (
    <section aria-labelledby="schedules-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="schedules-heading" ref={heading} tabIndex={-1} className="font-medium outline-none">
          Shift schedules in {group.name}
        </h2>
        {isAdmin && !group.archivedAt && (
          <Link
            to={`/schedules/new?groupId=${group.$id}`}
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            New schedule
          </Link>
        )}
      </div>
      {group.archivedAt && <Message>{ARCHIVED_NOTICE}</Message>}
      {schedules.data.length === 0 ? (
        <p className="text-muted-foreground">No schedules yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {schedules.data.map((schedule) => (
            <ScheduleRow
              key={schedule.$id}
              schedule={schedule}
              today={today}
              // An admin, or a member who set it up (never a viewer, permissions.md#roles);
              // nothing changes in an archived group.
              mayChange={
                !group.archivedAt &&
                (isAdmin || (role === 'member' && schedule.createdBy === personId))
              }
              onEnded={() => heading.current?.focus()}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Whether a schedule has ended by `today`: its end date, or its rule's own last date, has
 * passed. Stored dates are plain YYYY-MM-DD strings, which sort as text. A rule that ends after
 * a number of shifts can't be told from here.
 */
export function hasEnded(schedule: Pick<Schedules, 'endsOn' | 'rrule'>, today: string): boolean {
  const repeat = fromRrule(schedule.rrule)
  const until = repeat?.end === 'until' ? repeat.until : undefined
  return (
    (schedule.endsOn !== null && schedule.endsOn < today) || (until !== undefined && until < today)
  )
}

function ScheduleRow({
  schedule,
  today,
  mayChange,
  onEnded,
}: {
  schedule: Schedules
  today: string
  mayChange: boolean
  onEnded: () => void
}) {
  const repeat = fromRrule(schedule.rrule)
  const ended = hasEnded(schedule, today)
  const [ending, setEnding] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">
            {mayChange && !ended ? (
              <Link
                to={`/schedules/${schedule.$id}`}
                className="underline-offset-4 hover:underline"
              >
                {schedule.description}
              </Link>
            ) : (
              schedule.description
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {repeat ? describeRepeat(repeat, formatDate) : 'Custom rule'} · from{' '}
            {formatDate(schedule.startsOn)}
            {schedule.endsOn ? ` to ${formatDate(schedule.endsOn)}` : ''}
            {ended ? ' · Ended' : ''}
          </p>
        </div>
        {mayChange && !ended && !ending && (
          <Button ref={trigger} variant="outline" size="sm" onClick={() => setEnding(true)}>
            End
          </Button>
        )}
      </div>
      {ending && (
        <EndSchedule
          schedule={schedule}
          today={today}
          onCancel={() => {
            flushSync(() => setEnding(false))
            trigger.current?.focus()
          }}
          onEnded={(stopped) => {
            flushSync(() => setEnding(false))
            // Decided from the answer: ended (a past date), its End goes, so the list's heading;
            // still running (a later date), its End is back.
            if (hasEnded(stopped, today)) onEnded()
            else trigger.current?.focus()
          }}
        />
      )}
    </li>
  )
}

/** `POST /schedules/{id}/end`: the last date it may create, today by default. */
function EndSchedule({
  schedule,
  today,
  onCancel,
  onEnded,
}: {
  schedule: Schedules
  today: string
  onCancel: () => void
  onEnded: (stopped: Schedules) => void
}) {
  const end = useEndSchedule(schedule.$id)
  // Not before it starts.
  const [endsOn, setEndsOn] = useState(today < schedule.startsOn ? schedule.startsOn : today)
  const [error, setError] = useState<string>()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (end.isPending) return
        // Checked here, in words, before the scheduler would refuse it.
        const problem =
          endsOn === ''
            ? 'Required'
            : endsOn < schedule.startsOn
              ? `Pick a date on or after the start, ${formatDate(schedule.startsOn)}`
              : undefined
        setError(problem)
        if (!problem) end.mutate({ endsOn }, { onSuccess: ({ schedule }) => onEnded(schedule) })
      }}
    >
      <TextField
        id={`endsOn-${schedule.$id}`}
        type="date"
        label="Last date"
        hint="Shifts after this date that weren’t changed by hand are removed."
        ref={field}
        value={endsOn}
        min={schedule.startsOn}
        onChange={(event) => setEndsOn(event.target.value)}
        error={error ? { type: 'validate', message: error } : undefined}
      />
      {end.isError && (
        <p role="alert" className="text-sm text-destructive">
          {end.error.message}
        </p>
      )}
      <div className="flex gap-3">
        {/* aria-disabled, not disabled: a disabled button loses focus. */}
        <Button type="submit" size="sm" aria-disabled={end.isPending}>
          {end.isPending ? 'Ending…' : 'End schedule'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={end.isPending}
          onClick={() => !end.isPending && onCancel()}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
