import { idSchema } from '@ledgerly/core/schemas/common'
import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import { changeNotice } from './change-notice'
import { passwordNotice } from './password-notice'

// identity-and-invites.md#email-and-phone-change-notice, step 1: the whole name is matched, and
// `<userId>` is everything between `users.` and one of the four endings. A user ID can contain
// `.`, so `users.<victimId>.x.update.email` is user `<victimId>.x`'s event, not the victim's; a
// recovery token ID can't, so the match is unambiguous.
const EVENT_NAME =
  /^users\.(.+)\.(update\.password|recovery\.[^.]+\.update|update\.email|update\.phone)$/

/**
 * `identity POST /` as an event run (functions-api.md#identity), run without a JWT by the events
 * identity subscribes to. Only the user ID is read, from the event's name in `x-appwrite-event`,
 * and which event ran, from its end; a change event also checks it against the body's `$id`.
 * The body can carry the password hash, so it's never logged or stored. `{}` unless a send fails.
 */
export async function eventRun(
  services: Services,
  event: boolean,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, never>> {
  const match = event ? headers['x-appwrite-event']?.match(EVENT_NAME) : undefined
  const userId = idSchema.safeParse(match?.[1])
  if (!match || !userId.success) throw new AppError('FORBIDDEN', 'Only Appwrite sends this.')
  const ending = match[2]
  if (ending === 'update.email' || ending === 'update.phone') {
    await changeNotice(services, userId.data, ending === 'update.email' ? 'email' : 'phone', body)
  } else {
    await passwordNotice(services, userId.data)
  }
  return {}
}
