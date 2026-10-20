import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { type CreateInviteBody, createInviteBodySchema } from '@ledgerly/core/schemas/identity'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef } from 'react'
import { type FieldErrors, type Resolver, useForm } from 'react-hook-form'
import { queryKeys } from '../../lib/query-keys'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useCurrentUser } from '../auth/use-current-user'
import { type InviteError, type InviteSent, useSendInvite } from './use-send-invite'

// A failed send still counts toward the limits (identity-and-invites.md#invites, step 4), so the
// person decides when to try again (#369).
const NOT_SENDING = 'Email isn’t sending right now. Try again later.'
// The app-wide banner offers "Send it again" until the email is verified.
const UNVERIFIED =
  'Verify your email address before sending invites. The link is in the email we sent you; the banner at the top of the page can send it again.'

type InviteValues = { email: string }

/** The function's own schema, with the field's error in words. */
function inviteResolver(ids: {
  groupId: string
  memberId: string
}): Resolver<InviteValues, unknown, CreateInviteBody> {
  const resolve = schemaResolver<InviteValues, CreateInviteBody>(
    createInviteBodySchema,
    (values) => ({ ...ids, email: values.email }),
  )
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    if (!(result.errors as FieldErrors<InviteValues>).email) return result
    const message =
      values.email.trim() === ''
        ? 'Enter their email address'
        : 'Enter an email address like name@example.com'
    return { values: {}, errors: { email: { type: 'validate', message } } }
  }
}

/** The news after a send. The link stops working at `expiresAt` (14 days on), so the time counts. */
export function inviteSentText({ expiresAt }: InviteSent): string {
  const at = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `Invite sent. It expires on ${at.format(new Date(expiresAt))}.`
}

/**
 * Invite by email (#399): emails a `placeholder` member a link to join, at an address the caller
 * types. The app can't read identities, so it never shows or picks one; the function checks the
 * address is one this member's person was added with (identity-and-invites.md#invites). For those
 * who may add members (permissions.md#roles). A refusal keeps the form and its message: the
 * caller decides what's next.
 */
export function InviteForm({
  group,
  member,
  personId,
  onSent,
  onCancel,
}: {
  group: Groups
  member: Members
  /** The caller's person, for reloading their role after a refusal. */
  personId: string
  onSent: (invite: InviteSent) => void
  onCancel: () => void
}) {
  const ids = { heading: useId(), email: useId() }
  // The button that opened it is gone: focus goes to the field, as in the row's other forms.
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus()
  }, [])
  const queryClient = useQueryClient()
  const verified = useCurrentUser().data?.emailVerification
  const send = useSendInvite()
  const form = useForm<InviteValues, unknown, CreateInviteBody>({
    resolver: inviteResolver({ groupId: group.$id, memberId: member.$id }),
    defaultValues: { email: '' },
    // An error stays until Send is pressed again.
    reValidateMode: 'onSubmit',
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async (body) => {
    try {
      onSent(await send.mutateAsync(body))
    } catch (error) {
      const { code, message } = error as InviteError
      // Archived, or the caller's role changed, meanwhile (the role is checked before the email
      // is): reload them, so the page shows what they can do now.
      if (code === 'ARCHIVED' || code === 'FORBIDDEN' || code === 'NOT_A_MEMBER') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.group(group.$id) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.myMember(group.$id, personId) })
      }
      // The list isn't reloaded for a member who joined or went meanwhile: the form would go
      // with its message, and focus with it. It catches up on its next load.
      if (code === 'VALIDATION_FAILED') {
        // An error by the field isn't read out on its own: focus takes the reader there.
        form.setError('email', { message }, { shouldFocus: true })
      } else if (code === 'INTERNAL') form.setError('root', { message: NOT_SENDING })
      else if (code === 'FORBIDDEN' && verified === false) {
        form.setError('root', { message: UNVERIFIED })
      } else form.setError('root', { message })
    }
  })

  return (
    <form
      ref={ref}
      noValidate
      aria-labelledby={ids.heading}
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      onSubmit={(event) => {
        if (isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      <h3 id={ids.heading} className="min-w-0 font-medium break-words">
        Invite {member.displayName} by email
      </h3>
      <p className="text-sm text-muted-foreground">
        We email them a link to join, with your name and the group’s name.
      </p>
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id={ids.email}
        type="email"
        autoComplete="off"
        label="Their email address"
        hint="Use an address you added them with."
        error={errors.email}
        {...form.register('email')}
      />
      <div className="flex flex-wrap gap-3">
        {/* aria-disabled, not disabled, keeps focus on Send; the guard stops a second send. */}
        <Button type="submit" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-disabled={isSubmitting}
          onClick={() => !isSubmitting && onCancel()}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
