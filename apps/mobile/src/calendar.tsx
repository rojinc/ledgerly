import { addDays, endOfMonth, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useMonth } from './data'
import { Button, styles } from './ui'

/** The first of the month that `date` is in. */
const firstOf = (date: LocalDate) => `${date.slice(0, 8)}01` as LocalDate

/** A month of the user's joined groups, read only (#57). Dates are the rows' own strings. */
export function Calendar({
  userId,
  groups,
  timeZone,
}: {
  userId: string
  groups: Groups[]
  /** The profile's, as the web calendar uses. */
  timeZone: string
}) {
  const [start, setStart] = useState(() => firstOf(localToday(timeZone, new Date())))
  const end = endOfMonth(start)
  const byId = new Map(groups.map((group) => [group.$id, group]))
  const month = useMonth(
    userId,
    groups.map((group) => group.$id),
    start,
    end,
  )
  const days = new Map<string, Transactions[]>()
  for (const item of month.data ?? []) days.set(item.date, [...(days.get(item.date) ?? []), item])

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.row}>
        <Button onPress={() => setStart(firstOf(addDays(start, -1)))}>Previous</Button>
        <Text style={styles.title}>{start.slice(0, 7)}</Text>
        <Button onPress={() => setStart(addDays(end, 1))}>Next</Button>
      </View>
      {month.isError && <Text style={styles.error}>We couldn’t load this month.</Text>}
      {month.isPending && groups.length > 0 && <Text style={styles.muted}>Loading…</Text>}
      {(groups.length === 0 || month.data?.length === 0) && (
        <Text style={styles.muted}>Nothing this month.</Text>
      )}
      {[...days].map(([date, items]) => (
        <View key={date} style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>{date}</Text>
          {items.map((item) => (
            <View key={item.$id} style={styles.row}>
              <Text style={{ flexShrink: 1 }}>
                {item.description || item.kind}
                {item.status === 'posted' ? '' : ` (${item.status})`}
              </Text>
              <Text>{formatMoney(item.totalCents, byId.get(item.groupId)?.currency ?? 'AUD')}</Text>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  )
}
