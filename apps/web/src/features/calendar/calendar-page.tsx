import { isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { Link, useSearchParams } from 'react-router'
import { cn } from '../../lib/utils'
import { Button } from '../../ui/button'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroups } from '../groups/use-groups'
import { useProfile } from '../profile/use-profile'
import { type Month, monthGrid, monthOf, parseMonth, shiftMonth } from './month-grid'
import { type CalendarItem, useMonthTransactions } from './use-month-transactions'

// Group colours, told apart by hue; text always names the group too, so colour is never alone.
const COLOURS = [
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#9333ea',
  '#dc2626',
  '#0891b2',
  '#db2777',
  '#65a30d',
]

/** The same colour for a group every time, from its ID. */
export function groupColour(groupId: string): string {
  let hash = 0
  for (const char of groupId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLOURS[hash % COLOURS.length] as string
}

// ledger.md#statuses: dashed until real, solid when posted, struck through when void.
const STATUS_LABEL: Record<CalendarItem['status'], string | null> = {
  scheduled: 'Scheduled',
  due: 'Due',
  running: 'Running',
  posted: null,
  void: 'Void',
}

function chipStyle(status: CalendarItem['status']): string {
  if (status === 'posted') return 'border-solid'
  if (status === 'void') return 'border-solid line-through opacity-70'
  return 'border-dashed'
}

// A date string shown in words; UTC on both sides, so the browser's zone never moves the day.
function formatDay(date: LocalDate, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(
    Date.UTC(year, month - 1, day),
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const VISIBLE_PER_DAY = 3

export function CalendarPage() {
  const userId = useCurrentUser().data?.$id ?? ''
  const timeZone = useProfile(userId).data?.timezone
  const [params, setParams] = useSearchParams()
  const today = timeZone ? localToday(timeZone, new Date()) : undefined
  const month = parseMonth(params.get('month')) ?? (today ? monthOf(today) : undefined)
  const day = params.get('day')
  const selected = day && isLocalDate(day) ? day : undefined

  if (!month) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  }

  const go = (next: Month, nextDay?: LocalDate) =>
    setParams(nextDay ? { month: next, day: nextDay } : { month: next })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => go(shiftMonth(month, -1))}>
            <span aria-hidden="true">‹</span>
            <span className="sr-only">Previous month</span>
          </Button>
          <h2 aria-live="polite" className="min-w-36 text-center font-medium">
            {formatDay(`${month}-01` as LocalDate, { month: 'long', year: 'numeric' })}
          </h2>
          <Button variant="outline" size="sm" onClick={() => go(shiftMonth(month, 1))}>
            <span aria-hidden="true">›</span>
            <span className="sr-only">Next month</span>
          </Button>
          {today && (
            <Button variant="ghost" size="sm" onClick={() => go(monthOf(today), today)}>
              Today
            </Button>
          )}
        </div>
      </div>
      <MonthView month={month} today={today} selected={selected} onSelect={(d) => go(month, d)} />
    </div>
  )
}

function MonthView({
  month,
  today,
  selected,
  onSelect,
}: {
  month: Month
  today: LocalDate | undefined
  selected: LocalDate | undefined
  onSelect: (day: LocalDate) => void
}) {
  const groups = useGroups()
  const grid = monthGrid(month)
  const items = useMonthTransactions(groups.data, grid.start, grid.end)

  if (groups.isError || items.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-destructive">
          We couldn’t load your calendar.
        </p>
        <Button
          variant="outline"
          onClick={() => (groups.isError ? groups.refetch() : items.refetch())}
        >
          Try again
        </Button>
      </div>
    )
  }
  if (!groups.data || !items.data) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  }

  const byId = new Map(groups.data.map((group) => [group.$id, group]))
  const byDay = new Map<string, CalendarItem[]>()
  for (const item of items.data) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item])

  return (
    <>
      <ul aria-label="Groups" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {groups.data.map((group) => (
          <li key={group.$id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-3 rounded-sm"
              style={{ backgroundColor: groupColour(group.$id) }}
            />
            {group.name}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border">
        {WEEKDAYS.map((weekday) => (
          <div
            key={weekday}
            aria-hidden="true"
            className="bg-muted px-1 py-1 text-center text-xs font-medium"
          >
            {weekday}
          </div>
        ))}
        {grid.weeks.flat().map((date) => {
          const dayItems = byDay.get(date) ?? []
          const label = formatDay(date, { weekday: 'long', day: 'numeric', month: 'long' })
          return (
            <button
              key={date}
              type="button"
              aria-pressed={date === selected}
              aria-label={`${label}, ${dayItems.length === 1 ? '1 item' : `${dayItems.length} items`}`}
              onClick={() => onSelect(date)}
              className={cn(
                'flex min-h-20 min-w-0 flex-col items-stretch gap-0.5 bg-background p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                monthOf(date) !== month && 'text-muted-foreground',
                date === selected && 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'self-start rounded-full px-1 text-xs',
                  date === today && 'bg-primary font-semibold text-primary-foreground',
                )}
              >
                {Number(date.slice(8))}
              </span>
              {dayItems.slice(0, VISIBLE_PER_DAY).map((item) => (
                <span
                  key={item.$id}
                  aria-hidden="true"
                  className={cn(
                    'truncate rounded-sm border-2 px-0.5 text-[0.65rem] leading-tight',
                    chipStyle(item.status),
                  )}
                  style={{ borderColor: groupColour(item.groupId) }}
                >
                  {item.description}
                </span>
              ))}
              {dayItems.length > VISIBLE_PER_DAY && (
                <span aria-hidden="true" className="text-[0.65rem] text-muted-foreground">
                  +{dayItems.length - VISIBLE_PER_DAY} more
                </span>
              )}
            </button>
          )
        })}
      </div>
      {selected && <DayList date={selected} items={byDay.get(selected) ?? []} groups={byId} />}
    </>
  )
}

function DayList({
  date,
  items,
  groups,
}: {
  date: LocalDate
  items: CalendarItem[]
  groups: Map<string, Groups>
}) {
  return (
    <section aria-labelledby="day-heading" className="flex flex-col gap-2">
      <h2 id="day-heading" className="font-medium">
        {formatDay(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground">Nothing on this day.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((item) => {
            const group = groups.get(item.groupId)
            const status = STATUS_LABEL[item.status]
            return (
              <li key={item.$id}>
                <Link
                  to={`/transactions/${item.$id}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-5 w-1.5 shrink-0 rounded-sm border-2',
                        chipStyle(item.status),
                      )}
                      style={{ borderColor: groupColour(item.groupId) }}
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'block truncate font-medium',
                          item.status === 'void' && 'line-through',
                        )}
                      >
                        {item.description}
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {group?.name ?? 'Group'}
                        {status && ` · ${status}`}
                      </span>
                    </span>
                  </span>
                  {group && (
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(item.totalCents, group.currency)}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
