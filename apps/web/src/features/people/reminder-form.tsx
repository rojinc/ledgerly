import type { Groups } from '@ledgerly/core/generated/rows'
import { emailSchema } from '@ledgerly/core/schemas/common'
import type { SendReminderResult } from '@ledgerly/core/schemas/identity'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type FormEvent, type RefObject, useRef, useState } from 'react'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { useSwap } from '../../lib/use-swap'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'

const RATE_LIMITED = 'You’ve sent a reminder recently. Try again in a few days.'
// The app-wide banner offers "Send it again" until the email is verified.
const UNVERIFIED =
  'Verify your email address before sending reminders. The link is in the email we sent you; the banner at the top of the page can send it again.'

/**
 * Send a reminder (F-63, #266): to the other person in a pair group who owes you, at an address
 * you type. The app never shows their stored address; the function checks it's one the group
 * already holds for them (identity-and-invites.md#reminders).
 */
export function ReminderSection({ group, name }: { group: Groups; name: string }) {
  const swap = useSwap()
  const [sent, setSent] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      {swap.opened ? (
        <ReminderForm
          group={group}
          name={name}
          heading={swap.heading}
          onSent={() => {
            setSent(true)
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
  group,
  name,
  heading,
  onSent,
  onCancel,
}: {
  group: Groups
  name: string
  heading: RefObject<HTMLHeadingElement | null>
  onSent: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  // One ID per reminder, kept across retries after an error so it can't go twice (the function
  // answers a retry with the first one's time). The form closes once it's sent, and opening it
  // again makes a new one.
  const [id] = useState(() => ID.unique())
  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  // An error by the field isn't read out on its own: focus takes the reader there.
  const fieldProblem = (message: string) => {
    setFieldError(message)
    field.current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setFieldError('')
    setFailed('')
    if (email.trim() === '') {
      fieldProblem('Enter their email address')
      return
    }
    if (!emailSchema.safeParse(email).success) {
      fieldProblem('Enter an email address like name@example.com')
      return
    }
    setBusy(true)
    const result = await callFunction<SendReminderResult>('identity', 'POST', '/reminders', {
      id,
      groupId: group.$id,
      email,
    })
    setBusy(false)
    if (result.ok) {
      onSent()
      return
    }
    const { code, message } = result.error
    if (code === 'VALIDATION_FAILED') fieldProblem(message)
    else if (code === 'RATE_LIMITED') setFailed(RATE_LIMITED)
    else if (code === 'FORBIDDEN') setFailed(UNVERIFIED)
    else {
      // Archived meanwhile: reload the group, so the page shows it read-only.
      if (code === 'ARCHIVED') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.group(group.$id) })
      }
      setFailed(message)
    }
  }

  return (
    <form
      noValidate
      aria-labelledby="reminder-heading"
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      onSubmit={(event) => void submit(event)}
    >
      <h2 id="reminder-heading" ref={heading} tabIndex={-1} className="font-medium outline-none">
        Remind {name} what they owe
      </h2>
      <p className="text-sm text-muted-foreground">
        We email them the amount and your name, nothing else.
      </p>
      {failed && <Alert variant="destructive">{failed}</Alert>}
      <TextField
        id="reminderEmail"
        ref={field}
        type="email"
        autoComplete="off"
        label="Their email address"
        hint="Use an address you added them with."
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldError ? { type: 'validate', message: fieldError } : undefined}
      />
      <div className="flex flex-wrap gap-3">
        {/* aria-disabled, not disabled, keeps focus on Send; the guard stops a second send. */}
        <Button type="submit" aria-disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-disabled={busy}
          onClick={() => !busy && onCancel()}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
