import { useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { runChecks } from './checks'
import expected from './checks.expected.json'
import { styles } from './ui'

/** Core on this phone against what Node gives (#57). */
export function ChecksScreen() {
  const results = useMemo(runChecks, [])
  const rows = Object.entries(results).map(([name, result]) => {
    const want = (expected as Record<string, unknown>)[name]
    return { name, pass: JSON.stringify(result) === JSON.stringify(want), result, want }
  })
  const failed = rows.filter((row) => !row.pass).length
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>
        Checks: {failed === 0 ? `all ${rows.length} pass` : `${failed} of ${rows.length} fail`}
      </Text>
      <Text style={styles.muted}>
        Time zone {Intl.DateTimeFormat().resolvedOptions().timeZone}, locale{' '}
        {Intl.DateTimeFormat().resolvedOptions().locale}
      </Text>
      {rows.map((row) => (
        <View key={row.name}>
          <Text style={row.pass ? undefined : styles.error}>
            {row.pass ? 'PASS' : 'FAIL'} {row.name}
          </Text>
          {!row.pass && (
            <Text style={styles.muted}>
              got {JSON.stringify(row.result)}
              {'\n'}want {JSON.stringify(row.want)}
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  )
}
