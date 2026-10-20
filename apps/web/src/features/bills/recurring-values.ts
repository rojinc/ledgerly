import type { Category } from '@ledgerly/core/constants/categories'
import type { Schedules } from '@ledgerly/core/generated/rows'
import { parseMoney } from '@ledgerly/core/money/format'
import type { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import type { z } from 'zod'
import { type Repeat, toRrule, type Weekday } from '../schedules/rrule'

/** The recurring bill form's fields, as typed (#75); a house's (#403) adds the last four. */
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
  /** A house's: a bill, due on each date, or an expense, added on each date. */
  kind: 'bill' | 'expense'
  /** A house's: who pays each one. */
  paidBy: string
  /** A house's: split equally between everyone living there on each date, or those ticked. */
  split: 'everyone' | 'ticked'
  splitBetween: string[]
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
 *
 * In a house (#403) it names who pays, and the people ticked, if any: with none, each occurrence
 * is split equally between everyone living there on its date (ledger.md#default-split). A
 * recurring expense posts itself on each date, as nothing else posts a `scheduled` one.
 */
export function toRecurringInput(
  values: RecurringValues,
  ids: { id: string; groupId: string },
  currency: string,
  house = false,
): z.input<typeof scheduleInputSchema> {
  const totalCents = cents(values.amount, currency)
  const expense = house && values.kind === 'expense'
  return {
    ...ids,
    kind: expense ? 'expense' : 'bill',
    description: values.description.trim(),
    template: {
      totalCents,
      ...(values.category ? { category: values.category } : {}),
      ...(expense ? {} : { bill: { status: 'due' as const } }),
      ...(house ? { payers: [{ personId: values.paidBy, cents: totalCents }] } : {}),
      ...(house && values.split === 'ticked'
        ? { split: { mode: 'equal' as const, personIds: [...new Set(values.splitBetween)].sort() } }
        : {}),
    },
    rrule: toRrule(toRepeat(values)),
    startsOn: values.startsOn,
    skipPublicHolidays: false,
    autoPost: expense || values.autopay,
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

/**
 * The last date one can be due: the earlier of its end date (set by Stop) and the rule's UNTIL
 * (set by "Last due date"), or undefined when it has neither.
 */
export function lastDue(schedule: Pick<Schedules, 'endsOn' | 'rrule'>): string | undefined {
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(schedule.rrule)
  const dates = [schedule.endsOn, until ? `${until[1]}-${until[2]}-${until[3]}` : undefined]
  return dates.filter((date): date is string => Boolean(date)).sort()[0]
}
