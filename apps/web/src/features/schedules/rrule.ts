/** RFC 5545 weekday codes, Monday first (scheduling.md: weeks start on Monday). */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
}

/**
 * How often, as the form holds it. Only the shapes in scheduling.md#rules-the-ui-builds:
 * weekly on some days every 1–4 weeks, or monthly on day 1–28 or the last day. It may end
 * after a number of dates, on a date, or never.
 */
export type Repeat = {
  pattern: 'weekly' | 'monthly'
  days: Weekday[]
  interval: number
  /** 1–28, or -1 for the last day of the month. */
  monthDay: number
  end: 'never' | 'count' | 'until'
  count: string
  /** YYYY-MM-DD */
  until: string
}

/** The RRULE the API accepts, e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU`. */
export function toRrule(repeat: Repeat): string {
  const parts =
    repeat.pattern === 'weekly'
      ? [
          'FREQ=WEEKLY',
          ...(repeat.interval > 1 ? [`INTERVAL=${repeat.interval}`] : []),
          // In week order, whatever order they were picked in.
          `BYDAY=${WEEKDAYS.filter((day) => repeat.days.includes(day)).join(',')}`,
        ]
      : ['FREQ=MONTHLY', `BYMONTHDAY=${repeat.monthDay}`]
  if (repeat.end === 'count') parts.push(`COUNT=${repeat.count.trim()}`)
  if (repeat.end === 'until') parts.push(`UNTIL=${repeat.until.replaceAll('-', '')}`)
  return parts.join(';')
}

/**
 * The form's state for a stored rule, or undefined for a rule this form can't show (it only
 * ever saves the shapes above, so that means someone else wrote it).
 */
export function fromRrule(rule: string): Repeat | undefined {
  const parts = new Map(rule.split(';').map((part) => part.split('=') as [string, string]))
  const repeat: Repeat = {
    pattern: 'weekly',
    days: [],
    interval: 1,
    monthDay: 1,
    end: 'never',
    count: '',
    until: '',
  }
  const freq = parts.get('FREQ')
  if (freq === 'WEEKLY') {
    const days = (parts.get('BYDAY') ?? '').split(',')
    if (!days.every((day) => (WEEKDAYS as readonly string[]).includes(day))) return undefined
    repeat.days = days as Weekday[]
    repeat.interval = Number(parts.get('INTERVAL') ?? '1')
    if (![1, 2, 3, 4].includes(repeat.interval)) return undefined
  } else if (freq === 'MONTHLY') {
    repeat.pattern = 'monthly'
    repeat.monthDay = Number(parts.get('BYMONTHDAY'))
    if (
      !(
        repeat.monthDay === -1 ||
        (Number.isInteger(repeat.monthDay) && repeat.monthDay >= 1 && repeat.monthDay <= 28)
      )
    ) {
      return undefined
    }
  } else {
    return undefined
  }
  const count = parts.get('COUNT')
  const until = parts.get('UNTIL')
  if (count) {
    repeat.end = 'count'
    repeat.count = count
  } else if (until && /^\d{8}$/.test(until)) {
    repeat.end = 'until'
    repeat.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}`
  }
  return repeat
}

/** In words, for the list: "Every Thursday", "Every 2 weeks on Mon, Wed", "Last day of each month". */
export function describeRepeat(repeat: Repeat): string {
  if (repeat.pattern === 'monthly') {
    return repeat.monthDay === -1
      ? 'Last day of each month'
      : `On day ${repeat.monthDay} of each month`
  }
  const days = WEEKDAYS.filter((day) => repeat.days.includes(day))
  const names = days.map((day) =>
    days.length === 1 ? WEEKDAY_LABEL[day] : WEEKDAY_LABEL[day].slice(0, 3),
  )
  return repeat.interval > 1
    ? `Every ${repeat.interval} weeks on ${names.join(', ')}`
    : `Every ${names.join(', ')}`
}
