import type { Category } from '@ledgerly/core/constants/categories'
import type { Schedules } from '@ledgerly/core/generated/rows'
import { parseMoney } from '@ledgerly/core/money/format'
import type { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import type { z } from 'zod'
import { type Repeat, toRrule, type Weekday } from '../schedules/rrule'

/** The recurring bill form's fields, as typed (#75). */
export type RecurringValues = {
  description: string
  category: Category | ''
  amount: string
  /** Weekly on a day, monthly on a day, or the last day of each month. */
  repeat: 'weekly' | 'monthly' | 'last'
  weekday: Weekday
  /** 1–28, as typed. */
  monthDay: string
  /** The first due date. */
  startsOn: string
  /** The last date one can be due, or empty for no end. */
  until: string
  autopay: boolean
}

function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/** The rule as the schedule form's builder holds it (features/schedules/rrule.ts). */
export function toRepeat(values: RecurringValues): Repeat {
  return {
    pattern: values.repeat === 'weekly' ? 'weekly' : 'monthly',
    days: values.repeat === 'weekly' ? [values.weekday] : [],
    interval: 1,
    monthDay: values.repeat === 'last' ? -1 : Number(values.monthDay.trim() || Number.NaN),
    end: values.until ? 'until' : 'never',
    count: '',
    until: values.until,
  }
}

/**
 * `scheduler POST /schedules` for a recurring bill: each occurrence is a due bill on its date
 * (scheduling.md), paid automatically on that date with autopay. Bills aren't moved for public
 * holidays.
 */
export function toRecurringInput(
  values: RecurringValues,
  ids: { id: string; groupId: string },
  currency: string,
): z.input<typeof scheduleInputSchema> {
  return {
    ...ids,
    kind: 'bill',
    description: values.description.trim(),
    template: {
      totalCents: cents(values.amount, currency),
      ...(values.category ? { category: values.category } : {}),
      bill: { status: 'due' },
    },
    rrule: toRrule(toRepeat(values)),
    startsOn: values.startsOn,
    skipPublicHolidays: false,
    autoPost: values.autopay,
  }
}

/** A recurring bill's amount from its template, or undefined if it can't be read. */
export function templateCents(schedule: Pick<Schedules, 'templateJson'>): number | undefined {
  try {
    const total = (JSON.parse(schedule.templateJson) as { totalCents?: unknown } | null)?.totalCents
    return Number.isInteger(total) ? (total as number) : undefined
  } catch {
    return undefined
  }
}

/** Stopped, or past its last date: nothing more is made. */
export function hasEnded(schedule: Pick<Schedules, 'endsOn' | 'rrule'>, today: string): boolean {
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(schedule.rrule)
  const last = schedule.endsOn ?? (until ? `${until[1]}-${until[2]}-${until[3]}` : undefined)
  return last !== undefined && last < today
}
