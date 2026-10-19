import type { Groups } from '@ledgerly/core/generated/rows'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { ID } from 'react-native-appwrite'
import { callFunction } from './api'
import { useMyRoles, useRunningTimer } from './data'
import { Button, styles } from './ui'

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/**
 * Today's timer in an employer group the user owns (#57): start and stop through `ledger`
 * executions, never a table write (D-003).
 */
export function Today({ personId, groups }: { personId: string; groups: Groups[] }) {
  const queryClient = useQueryClient()
  const employers = groups.filter((group) => group.type === 'employer' && !group.archivedAt)
  const roles = useMyRoles(
    personId,
    employers.map((group) => group.$id),
  )
  // As the web's Today: only the group's owner, as its admin, times shifts (the function checks).
  const owned = employers.filter(
    (group) => group.ownerPersonId === personId && roles.data?.get(group.$id) === 'admin',
  )
  const [groupId, setGroupId] = useState('')
  const group = owned.find((item) => item.$id === groupId) ?? owned[0]
  const running = useRunningTimer(
    personId,
    owned.map((item) => item.$id),
  )
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  const call = async (path: string, body: unknown) => {
    setBusy(true)
    setError('')
    const result = await callFunction('ledger', 'POST', path, body)
    if (!result.ok && result.error.code === 'UNAUTHENTICATED') {
      queryClient.setQueryData(['currentUser'], null)
      return
    }
    if (!result.ok) setError(result.error.message)
    await queryClient.invalidateQueries({ queryKey: ['running'] })
    await queryClient.invalidateQueries({ queryKey: ['calendar'] })
    setBusy(false)
  }

  if (roles.isPending && employers.length > 0) return <Text style={styles.muted}>Loading…</Text>
  if (!group) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>You don’t own an employer group to time shifts in.</Text>
      </View>
    )
  }
  const timer = running.data
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Today</Text>
      {owned.length > 1 &&
        owned.map((item) => (
          <Button
            key={item.$id}
            disabled={item.$id === group.$id}
            onPress={() => setGroupId(item.$id)}
          >
            {item.name}
          </Button>
        ))}
      {error !== '' && <Text style={styles.error}>{error}</Text>}
      {running.isPending ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : timer?.startedAt ? (
        <>
          <Text style={{ fontSize: 40, fontVariant: ['tabular-nums'] }}>
            {elapsed(timer.startedAt, now)}
          </Text>
          <Button
            disabled={busy}
            onPress={() => void call('/timer/stop', { transactionId: timer.$id })}
          >
            Stop
          </Button>
        </>
      ) : (
        <Button
          disabled={busy}
          onPress={() => void call('/timer/start', { id: ID.unique(), groupId: group.$id })}
        >
          Start timer in {group.name}
        </Button>
      )}
    </View>
  )
}
