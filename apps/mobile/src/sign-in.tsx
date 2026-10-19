import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { ID } from 'react-native-appwrite'
import { account } from './appwrite'
import { Button, styles } from './ui'

/** Email and password, or an emailed code, as the web's login page (#57). No sign-up here. */
export function SignIn() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeUserId, setCodeUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      // The SDK's message can name the account's state; a fixed one says no more than the web's.
      setError('That didn’t work. Check what you typed and try again.')
    } finally {
      setBusy(false)
    }
  }
  const signedIn = () => queryClient.invalidateQueries({ queryKey: ['currentUser'] })

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Sign in</Text>
      {error !== '' && <Text style={styles.error}>{error}</Text>}
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      {codeUserId === '' ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="Password"
            secureTextEntry
            autoComplete="current-password"
            value={password}
            onChangeText={setPassword}
          />
          <Button
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await account.createEmailPasswordSession({ email: email.trim(), password })
                setPassword('')
                await signedIn()
              })
            }
          >
            Sign in
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const token = await account.createEmailToken({
                  userId: ID.unique(),
                  email: email.trim(),
                })
                setCodeUserId(token.userId)
              })
            }
          >
            Email me a code
          </Button>
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="6-digit code"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            value={code}
            onChangeText={setCode}
          />
          <Button
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await account.createSession({ userId: codeUserId, secret: code.trim() })
                await signedIn()
              })
            }
          >
            Sign in with the code
          </Button>
        </>
      )}
    </View>
  )
}
