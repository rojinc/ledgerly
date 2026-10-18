import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { ID } from 'appwrite'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { queryKeys } from '../../lib/query-keys'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroups } from '../groups/use-groups'
import { elapsedText } from './shift-values'
import { useMyRoles, useStartTimer, useStopTimer, useToday } from './use-shifts'

/** The time now, once a second, for the running duration. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

const STATUS: Record<Transactions['status'], string> = {
  scheduled: 'Scheduled',
  due: 'Due',
  running: 'Running',
  posted: 'Confirmed',
  void: 'Void',
}

/** `/today`: start and stop a timed shift, and today's shifts in each employer group. */
export function TodayPage() {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const groups = useGroups()
  const employers = groups.data?.filter((group) => group.type === 'employer')
  const today = useToday(employers, personId)
  const roles = useMyRoles(employers, personId)
  const todayKey = queryKeys.today(
    userId,
    (employers ?? []).map((group) => group.$id),
  )
  // Here, not in the timer panels: an optimistic start or stop swaps the panel, and a rollback
  // must still show the error and retry with the same ID and employer.
  const start = useStartTimer(todayKey)
  const stop = useStopTimer(todayKey)
  const [startId, setStartId] = useState(() => ID.unique())
  const [startGroupId, setStartGroupId] = useState('')
  const [breakMinutes, setBreakMinutes] = useState('')

  if (!employers || !today.data || !roles.data) {
    const failed =
      (groups.isError && !groups.data) ||
      (today.isError && !today.data) ||
      (roles.isError && !roles.data)
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Today</h1>
        {failed ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-destructive">
              We couldn’t load today’s shifts.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                if (groups.isError) void groups.refetch()
                if (today.isError) void today.refetch()
                if (roles.isError) void roles.refetch()
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-muted-foreground">
            Loading…
          </p>
        )}
      </div>
    )
  }

  const byId = new Map(employers.map((group) => [group.$id, group]))
  const open = employers.filter((group) => !group.archivedAt)
  // permissions.md: admins and members add shifts; only the group's owner, the worker the shift
  // pays, times them (functions-api.md#ledger; the function checks).
  const adders = open.filter((group) =>
    ['admin', 'member'].includes(roles.data.get(group.$id) ?? ''),
  )
  const starters = open.filter(
    (group) => group.ownerPersonId === personId && roles.data.get(group.$id) === 'admin',
  )
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Today</h1>
        {adders.length > 0 && (
          <Link
            to="/shifts/new"
            className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add a shift
          </Link>
        )}
      </div>
      {open.length === 0 ? (
        <p className="text-muted-foreground">
          Add an employer to record shifts:{' '}
          <Link to="/groups/new-employer" className="underline underline-offset-4">
            New employer
          </Link>
        </p>
      ) : today.data.running ? (
        <RunningTimer
          shift={today.data.running}
          group={byId.get(today.data.running.groupId)}
          stop={stop}
          // Stopped: an earlier start error no longer applies.
          onStopped={() => start.reset()}
          breakMinutes={breakMinutes}
          onBreak={setBreakMinutes}
        />
      ) : starters.length === 0 ? null : (
        <StartTimer
          groups={starters}
          // The optimistic stop shows Start at once; starting before it lands would conflict.
          disabled={stop.isPending}
          start={start}
          groupId={
            starters.some((group) => group.$id === startGroupId)
              ? startGroupId
              : (starters[0]?.$id ?? '')
          }
          onGroup={setStartGroupId}
          onStart={(groupId) =>
            start.mutate(
              { id: startId, groupId },
              {
                onSuccess: () => {
                  setStartId(ID.unique())
                  setBreakMinutes('')
                  // A new timer: the last one's stop error no longer applies.
                  stop.reset()
                },
              },
            )
          }
        />
      )}
      <section aria-labelledby="today-shifts" className="flex flex-col gap-2">
        <h2 id="today-shifts" className="font-medium">
          Today’s shifts
        </h2>
        {today.data.shifts.length === 0 ? (
          <p className="text-muted-foreground">No shifts today.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {today.data.shifts.map((shift) => {
              const group = byId.get(shift.groupId)
              return (
                <li key={shift.$id}>
                  <Link
                    to={`/shifts/${shift.$id}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <span className="min-w-0">
                      <span
                        className={`block truncate font-medium ${shift.status === 'void' ? 'line-through' : ''}`}
                      >
                        {shift.description}
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {group?.name ?? 'Employer'} · {STATUS[shift.status]}
                      </span>
                    </span>
                    {group && shift.status !== 'running' && (
                      <span className="shrink-0 tabular-nums">
                        {formatMoney(shift.totalCents, group.currency)}
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function StartTimer({
  groups,
  start,
  disabled,
  groupId,
  onGroup,
  onStart,
}: {
  groups: Groups[]
  start: ReturnType<typeof useStartTimer>
  disabled: boolean
  groupId: string
  onGroup: (groupId: string) => void
  onStart: (groupId: string) => void
}) {
  return (
    <section
      aria-labelledby="timer"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <h2 id="timer" className="font-medium">
        Timer
      </h2>
      {groups.length > 1 && (
        <label className="flex flex-col gap-2 text-sm font-medium">
          Employer
          <select
            value={groupId}
            onChange={(event) => onGroup(event.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {groups.map((group) => (
              <option key={group.$id} value={group.$id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {start.isError && (
        <p role="alert" className="text-sm text-destructive">
          {start.error.message}
        </p>
      )}
      <Button
        className="self-start"
        disabled={start.isPending || disabled}
        onClick={() => onStart(groupId)}
      >
        Start
      </Button>
    </section>
  )
}

function RunningTimer({
  shift,
  group,
  stop,
  onStopped,
  breakMinutes,
  onBreak,
}: {
  shift: Transactions
  group: Groups | undefined
  stop: ReturnType<typeof useStopTimer>
  onStopped: () => void
  breakMinutes: string
  onBreak: (text: string) => void
}) {
  const now = useNow()
  const [error, setError] = useState<string>()
  const started = shift.startedAt ? Date.parse(shift.startedAt) : now
  return (
    <section
      aria-labelledby="timer"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <h2 id="timer" className="font-medium">
        Timer running{group ? ` · ${group.name}` : ''}
      </h2>
      <p className="text-3xl font-semibold tabular-nums" role="timer" aria-live="off">
        {elapsedText((now - started) / 1000)}
      </p>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const text = breakMinutes.trim()
          if (text !== '' && !/^\d+$/.test(text)) {
            setError('Enter whole minutes')
            return
          }
          setError(undefined)
          stop.mutate(
            { transactionId: shift.$id, ...(text === '' ? {} : { breakMinutes: Number(text) }) },
            {
              onSuccess: () => {
                onBreak('')
                onStopped()
              },
            },
          )
        }}
      >
        <TextField
          id="timerBreak"
          inputMode="numeric"
          label="Break (minutes)"
          value={breakMinutes}
          onChange={(event) => onBreak(event.target.value)}
          error={error ? { type: 'validate', message: error } : undefined}
        />
        {stop.isError && (
          <p role="alert" className="text-sm text-destructive">
            {stop.error.message}
          </p>
        )}
        <Button type="submit" className="self-start" disabled={stop.isPending}>
          Stop
        </Button>
        <Link
          to={`/shifts/${shift.$id}`}
          className="self-start text-sm underline underline-offset-4"
        >
          Can’t stop it? Open the shift to void it
        </Link>
      </form>
    </section>
  )
}
