import type { Groups } from '@ledgerly/core/generated/rows'
import {
  type SendReminderBody,
  type SendReminderResult,
  sendReminderBodySchema,
} from '@ledgerly/core/schemas/identity'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type RefObject, useState } from 'react'
import { type FieldErrors, type Resolver, useForm } from 'react-hook-form'
import { callFunction, type ErrorCode } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { schemaResolver } from '../../lib/schema-resolver'
import { useSwap } from '../../lib/use-swap'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useCurrentUser } from '../auth/use-current-user'

const RATE_LIMITED = 'You’ve sent a reminder recently. Try again in a few days.'
// The app-wide banner offers "Send it again" until the email is verified.
const UNVERIFIED =
  'Verify your email address before sending reminders. The link is in the email we sent you; the banner at the top of the page can send it again.'

type ReminderValues = { email: string }

/** A refusal, keeping its code so the form can say more than the message. */
class ReminderError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** The function's own schema, with the field's error in words. */
function reminderResolver(ids: {
  id: string
  groupId: string
}): Resolver<ReminderValues, unknown, SendReminderBody> {
  const resolve = schemaResolver<ReminderValues, SendReminderBody>(
    sendReminderBodySchema,
    (values) => ({ ...ids, email: values.email }),
  )
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    if (!(result.errors as FieldErrors<ReminderValues>).email) return result
    const message =
      values.email.trim() === ''
        ? 'Enter their email address'
        : 'Enter an email address like name@example.com'
    return { values: {}, errors: { email: { type: 'validate', message } } }
  }
}

/**
 * Send a reminder (F-63, #266): to the other person in a pair group who owes you, at an address
 * you type. The app never shows their stored address; the function checks it's one the group
 * already holds for them (identity-and-invites.md#reminders).
 */
export function ReminderSection({
  group,
  personId,
  name,
}: {
  group: Groups
  personId: string
  name: string
}) {
  const swap = useSwap()
  const [sent, setSent] = useState(false)
  // One ID per reminder, kept across retries after an error, Cancel included, so it can't go
  // twice (the function answers a retry with the first one's time). Only a success makes a new one.
  const [id, setId] = useState(() => ID.unique())
  return (
    <div className="flex flex-col gap-2">
      {swap.opened ? (
        <ReminderForm
          id={id}
          group={group}
          personId={personId}
          name={name}
          heading={swap.heading}
          onSent={() => {
            setSent(true)
            setId(ID.unique())
            swap.close()
          }}
          onCancel={swap.close}
        />
      ) : (
        <Button
          ref={swap.trigger}
          variant="outline"
          className="self-start"
          onClick={() => {
            setSent(false)
            swap.open()
          }}
        >
          Send a reminder
        </Button>
      )}
      {/* Mounted from the start, so the news is read out. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {sent ? 'Reminder sent.' : ''}
      </p>
    </div>
  )
}

function ReminderForm({
  id,
  group,
  personId,
  name,
  heading,
  onSent,
  onCancel,
}: {
  id: string
  group: Groups
  personId: string
  name: string
  heading: RefObject<HTMLHeadingElement | null>
  onSent: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const verified = useCurrentUser().data?.emailVerification
  const send = useMutation({
    mutationFn: async (body: SendReminderBody) => {
      const result = await callFunction<SendReminderResult>('identity', 'POST', '/reminders', body)
      if (!result.ok) throw new ReminderError(result.error.code, result.error.message)
      return result.data
    },
  })
  const form = useForm<ReminderValues, unknown, SendReminderBody>({
    resolver: reminderResolver({ id, groupId: group.$id }),
    defaultValues: { email: '' },
    // An error stays until Send is pressed again.
    reValidateMode: 'onSubmit',
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async (body) => {
    try {
      await send.mutateAsync(body)
      onSent()
    } catch (error) {
      const { code, message } = error as ReminderError
      if (code === 'VALIDATION_FAILED') {
        // It may be "Nothing is owed to you": reload the balance, so the button goes if so.
        void queryClient.invalidateQueries({ queryKey: queryKeys.balances(group.$id) })
        // An error by the field isn't read out on its own: focus takes the reader there.
        form.setError('email', { message }, { shouldFocus: true })
      } else if (code === 'RATE_LIMITED') form.setError('root', { message: RATE_LIMITED })
      else if (code === 'FORBIDDEN' && verified === false) {
        form.setError('root', { message: UNVERIFIED })
      } else {
        // Archived, or the caller's role changed, meanwhile: reload them, so the page shows what
        // they can do now.
        if (code === 'ARCHIVED' || code === 'FORBIDDEN') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.group(group.$id) })
          void queryClient.invalidateQueries({ queryKey: queryKeys.myMember(group.$id, personId) })
        }
        form.setError('root', { message })
      }
    }
  })

  return (
    <form
      noValidate
      aria-labelledby="reminder-heading"
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      onSubmit={(event) => {
        if (isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      <h2
        id="reminder-heading"
        ref={heading}
        tabIndex={-1}
        className="min-w-0 font-medium break-words outline-none"
      >
        Remind {name} what they owe
      </h2>
      <p className="text-sm text-muted-foreground">
        We email them the amount and your name, nothing else.
      </p>
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id="reminderEmail"
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
