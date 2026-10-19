import { AppwriteException } from 'appwrite'
import { account } from '../../lib/appwrite'

/**
 * Signs out every session but this one and says how many it signed out (#290). Not
 * `account.deleteSessions()`: on Appwrite 1.8.1 that deletes this session too.
 */
export async function signOutOtherSessions(): Promise<number> {
  const { sessions } = await account.listSessions()
  const others = sessions.filter((session) => !session.current)
  await Promise.all(
    others.map((session) =>
      account.deleteSession({ sessionId: session.$id }).catch((error: unknown) => {
        // 404: it expired or was deleted meanwhile, so it's signed out either way.
        if (!(error instanceof AppwriteException && error.code === 404)) throw error
      }),
    ),
  )
  return others.length
}
