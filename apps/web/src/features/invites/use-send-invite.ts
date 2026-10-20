import type { Invites } from '@ledgerly/core/generated/rows'
import type { CreateInviteBody } from '@ledgerly/core/schemas/identity'
import { useMutation } from '@tanstack/react-query'
import { callFunction, type ErrorCode } from '../../lib/api'

export type InviteSent = Pick<Invites, 'sentAt' | 'expiresAt'>

/** A refusal, keeping its code so the form can say more than the message. */
export class InviteError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * `identity POST /invites` (identity-and-invites.md#invites). Never retried: each call is a new
 * invite, and its address check counts toward the sender's limit whether or not the email goes
 * (#274, #369), so only the person sends again.
 */
export function useSendInvite() {
  return useMutation({
    mutationFn: async (body: CreateInviteBody) => {
      const result = await callFunction<InviteSent>('identity', 'POST', '/invites', body)
      if (!result.ok) throw new InviteError(result.error.code, result.error.message)
      return result.data
    },
    retry: false,
  })
}
