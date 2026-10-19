import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Profiles } from '@ledgerly/core/generated/rows'
import type { HoursCap } from '@ledgerly/core/schemas/identity'

/** The profile's work-hours limit (F-82, data-model.md#profiles), or null with none set. */
export function hoursCapOf(
  profile: Pick<Profiles, 'hoursCapMinutes' | 'hoursCapPeriod' | 'hoursCapStartsOn'>,
): HoursCap | null {
  const { hoursCapMinutes: minutes, hoursCapPeriod: period, hoursCapStartsOn: startsOn } = profile
  // `== null`: a profile cached from before these columns has none of them.
  if (minutes == null || period == null) return null
  if (period === 'week') return { minutes, period }
  return startsOn == null ? null : { minutes, period, startsOn: startsOn as LocalDate }
}
