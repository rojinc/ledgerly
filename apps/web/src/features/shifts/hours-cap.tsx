import { capPeriod, minutesInPeriod } from '@ledgerly/core/dates/hours-cap'
import { type DateRange, isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Transactions } from '@ledgerly/core/generated/rows'
import type { HoursCap } from '@ledgerly/core/schemas/identity'
import { useQuery } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { useEffect, useState } from 'react'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroups } from '../groups/use-groups'
import { hoursCapOf } from '../profile/hours-cap-values'
import { useProfile } from '../profile/use-profile'
import { listAll } from './use-shifts'

// Appwrite's limit for the values of one Query.equal.
const PAGE = 100

/** Minutes in words: 1890 → `31 h 30 min`, 2400 → `40 h`, 45 → `45 min`. */
export function durationText(minutes: number): string {
  const rest = minutes % 60
  const hours = (minutes - rest) / 60
  if (rest === 0) return `${hours} h`
  return hours === 0 ? `${rest} min` : `${hours} h ${rest} min`
}

/** At or over the limit, in words; nothing under it. */
function overText(total: number, cap: HoursCap): string | undefined {
  if (total === cap.minutes) return 'You’ve reached your limit.'
  if (total > cap.minutes) return `${durationText(total - cap.minutes)} over your limit.`
  return undefined
}

/** The time now, once a minute, so the period moves on at the profile's local midnight. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** A shift that counts towards the limit: its paid minutes on its date. */
export type CapShift = { $id: string; date: LocalDate; minutes: number }

function paidMinutesOf(row: Pick<Transactions, 'inputJson'>): number {
  try {
    const minutes = (JSON.parse(row.inputJson) as { shift?: { minutes?: unknown } }).shift?.minutes
    return Number.isInteger(minutes) ? (minutes as number) : 0
  } catch {
    return 0
  }
}

/**
 * The user's limit and their shifts in the period that holds `date` (today, in the profile's time
 * zone, by default). Shifts count in every employer group they own, the worker the shift pays,
 * archived ones too, when posted or scheduled (#53). Nothing is read with no limit set. The key
 * is under `today`, which every shift write refreshes.
 */
export function useHoursCap(date?: string) {
  const userId = useCurrentUser().data?.$id ?? ''
  const profile = useProfile(userId).data
  const groups = useGroups().data
  const now = useMinute()
  const cap = profile ? hoursCapOf(profile) : null
  const day = date === undefined && profile ? localToday(profile.timezone, new Date(now)) : date
  const period: DateRange | undefined =
    cap && day !== undefined && isLocalDate(day) ? capPeriod(cap, day) : undefined
  const personId = profile?.personId
  const owned = personId
    ? groups
        ?.filter((group) => group.type === 'employer' && group.ownerPersonId === personId)
        .map((group) => group.$id)
    : undefined
  const shifts = useQuery({
    queryKey: ['today', 'hours-cap', userId, period?.start, period?.end, ...(owned ?? [])],
    enabled: period !== undefined && owned !== undefined,
    queryFn: async (): Promise<CapShift[]> => {
      const range = period as DateRange
      const ids = owned as string[]
      const found: CapShift[] = []
      for (let index = 0; index < ids.length; index += PAGE) {
        // idx_group_date, with only the columns the sum needs.
        const rows = await listAll([
          Query.equal('groupId', ids.slice(index, index + PAGE)),
          Query.greaterThanEqual('date', range.start),
          Query.lessThanEqual('date', range.end),
          Query.equal('kind', 'shift'),
          Query.equal('status', ['posted', 'scheduled']),
          Query.select(['$id', 'date', 'status', 'inputJson']),
        ])
        for (const row of rows) {
          found.push({ $id: row.$id, date: row.date as LocalDate, minutes: paidMinutesOf(row) })
        }
      }
      return found
    },
  })
  return {
    cap,
    period,
    shifts: shifts.data,
    owns: (groupId: string) => owned?.includes(groupId) ?? false,
  }
}

function CapText({ text, total, cap }: { text: string; total: number; cap: HoursCap }) {
  const over = overText(total, cap)
  return (
    <>
      {text}
      {over && (
        <>
          {' '}
          <strong className="font-semibold">{over}</strong>
        </>
      )}
    </>
  )
}

/**
 * Today and Home: "This week: 31 h 30 min of your 40 h." With `running`, Today's timer counts
 * its minutes so far. Nothing shows with no limit set.
 */
export function HoursCapSummary({ running }: { running?: Transactions }) {
  const { cap, period, shifts, owns } = useHoursCap()
  const now = useMinute()
  if (!cap || !period || !shifts) return null
  let total = minutesInPeriod(shifts, period)
  if (
    running?.startedAt &&
    owns(running.groupId) &&
    running.date >= period.start &&
    running.date <= period.end
  ) {
    total += Math.max(0, Math.floor((now - Date.parse(running.startedAt)) / 60_000))
  }
  return (
    <p className="text-sm">
      <CapText
        text={`This ${cap.period}: ${durationText(total)} of your ${durationText(cap.minutes)}.`}
        total={total}
        cap={cap}
      />
    </p>
  )
}

/**
 * The shift form: "With this shift: 42 h of your 40 h this week." From the shift's own date
 * and minutes; an edit's stored row isn't counted again. It only warns: saving still works.
 */
export function ShiftCapLine({
  id,
  groupId,
  date,
  minutes,
}: {
  id: string
  groupId: string
  date: string
  minutes: number
}) {
  const { cap, period, shifts, owns } = useHoursCap(date)
  if (!cap) return null
  const shown =
    period && shifts && owns(groupId) && Number.isInteger(minutes) && minutes >= 0
      ? minutesInPeriod(
          shifts.filter((shift) => shift.$id !== id),
          period,
        ) + minutes
      : undefined
  return (
    <p aria-live="polite" className="text-sm">
      {shown !== undefined && cap && (
        <CapText
          text={`With this shift: ${durationText(shown)} of your ${durationText(cap.minutes)} this ${cap.period}.`}
          total={shown}
          cap={cap}
        />
      )}
    </p>
  )
}
