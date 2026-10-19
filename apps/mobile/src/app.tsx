import { type BootstrapResult, bootstrapBodySchema } from '@ledgerly/core/schemas/identity'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { AppwriteException } from 'react-native-appwrite'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { callFunction } from './api'
import { account } from './appwrite'
import { Calendar } from './calendar'
import { ChecksScreen } from './checks-screen'
import { useGroups } from './data'
import { SignIn } from './sign-in'
import { Today } from './today'
import { Button, styles } from './ui'

const CURRENT_USER = ['currentUser']

/** The session ended (a 401): back to Sign in. */
class SessionEnded extends Error {}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (
        error instanceof SessionEnded ||
        (error instanceof AppwriteException && error.code === 401)
      ) {
        queryClient.setQueryData(CURRENT_USER, null)
      }
    },
  }),
  defaultOptions: {
    queries: {
      // A 401 won't pass next time; anything else, such as a lost connection, may.
      retry: (failures, error) =>
        !(error instanceof SessionEnded) &&
        !(error instanceof AppwriteException && error.code === 401) &&
        failures < 3,
    },
  },
})

export function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
          <StatusBar style="auto" />
          <Root />
        </SafeAreaView>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

/** The signed-in user, or null. The SDK should keep the session across a restart (#57 checks it). */
function useCurrentUser() {
  return useQuery({
    queryKey: CURRENT_USER,
    queryFn: async () => {
      try {
        return await account.get()
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 401) return null
        throw error
      }
    },
  })
}

function Root() {
  const user = useCurrentUser()
  if (user.isPending) return <Text style={styles.muted}>Loading…</Text>
  if (user.isError) {
    return (
      <View style={styles.screen}>
        <Text style={styles.error}>We couldn’t reach the server.</Text>
        <Button onPress={() => void user.refetch()}>Try again</Button>
      </View>
    )
  }
  return user.data ? <SignedIn userId={user.data.$id} /> : <SignIn />
}

type Tab = 'checks' | 'calendar' | 'today'

function SignedIn({ userId }: { userId: string }) {
  const client = useQueryClient()
  const [tab, setTab] = useState<Tab>('checks')
  // identity POST /bootstrap once per session, before any group is read, as the web does.
  const bootstrap = useQuery({
    queryKey: ['bootstrap', userId],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const parsed = bootstrapBodySchema.safeParse({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      const result = await callFunction<BootstrapResult>(
        'identity',
        'POST',
        '/bootstrap',
        parsed.success ? parsed.data : { timezone: 'UTC' },
      )
      if (!result.ok && result.error.code === 'UNAUTHENTICATED') {
        throw new SessionEnded(result.error.message)
      }
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    },
  })
  const groups = useGroups(userId, bootstrap.isSuccess)
  const logOut = useMutation({
    mutationFn: () => account.deleteSession({ sessionId: 'current' }),
    onSuccess: () => {
      // Drop every cached row so the next user never sees this user's data.
      client.clear()
      client.setQueryData(CURRENT_USER, null)
    },
  })

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.row, { padding: 8 }]}>
        {(['checks', 'calendar', 'today'] as const).map((name) => (
          <Button key={name} disabled={tab === name} onPress={() => setTab(name)}>
            {name[0]?.toUpperCase() + name.slice(1)}
          </Button>
        ))}
        <Button disabled={logOut.isPending} onPress={() => logOut.mutate()}>
          Log out
        </Button>
      </View>
      {logOut.isError && <Text style={styles.error}>We couldn’t log you out. Try again.</Text>}
      {bootstrap.isError && <Text style={styles.error}>{bootstrap.error.message}</Text>}
      {tab === 'checks' ? (
        <ChecksScreen />
      ) : !bootstrap.data || !groups.data ? (
        <Text style={styles.muted}>
          {groups.isError ? 'We couldn’t load your groups.' : 'Loading…'}
        </Text>
      ) : tab === 'calendar' ? (
        <Calendar userId={userId} groups={groups.data} timeZone={bootstrap.data.profile.timezone} />
      ) : (
        <Today personId={bootstrap.data.personId} groups={groups.data} />
      )}
    </View>
  )
}
