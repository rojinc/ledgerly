import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'

/** Plain, readable screens only: styling is out of the spike's scope. */
export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  // For a ScrollView's content: `flex: 1` would cap it at the screen's height.
  scroll: { padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 10, fontSize: 16 },
  error: { color: '#b00020' },
  muted: { color: '#666' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
})

export function Button({
  children,
  onPress,
  disabled,
}: {
  children: ReactNode
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={{ backgroundColor: disabled ? '#999' : '#222', borderRadius: 6, padding: 12 }}
    >
      <Text style={{ color: '#fff', textAlign: 'center', fontSize: 16 }}>{children}</Text>
    </Pressable>
  )
}
