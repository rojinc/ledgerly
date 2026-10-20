import type { Profiles } from '@ledgerly/core/generated/rows'
import {
  type EmailType,
  emailTypeSchema,
  type UpdateProfileBody,
} from '@ledgerly/core/schemas/identity'
import { type FormEvent, useState } from 'react'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'

// In the contract's order, which is also the order they're saved in.
const EMAIL_TYPES = emailTypeSchema.options

const OPTIONS: Record<EmailType, { label: string; hint: string }> = {
  billDue: { label: 'Bill due soon', hint: 'Two days before a bill is due.' },
  shiftToConfirm: {
    label: 'Shift to confirm',
    hint: 'When a past shift of yours still needs confirming.',
  },
  transactionChanged: {
    label: 'A transaction you’re in was changed',
    hint: 'When someone else edits or voids one: at most one email an hour.',
  },
  statementReady: {
    label: 'Statement ready',
    hint: 'When an invoice or divide is drafted. Drafts still appear under Statements.',
  },
}

type Props = {
  profile: Profiles
  onSave: (body: UpdateProfileBody) => Promise<unknown>
}

/**
 * The emails the user can turn off (#431, F-06): ticked means on. Saved as the ones turned off
 * (`emailOptOuts`), the whole list at once.
 */
export function EmailSettingsForm({ profile, onSave }: Props) {
  const [off, setOff] = useState<ReadonlySet<string>>(new Set(profile.emailOptOuts ?? []))
  const [failed, setFailed] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setFailed('')
    setSaving(true)
    try {
      await onSave({ emailOptOuts: EMAIL_TYPES.filter((type) => off.has(type)) })
      setSaved(true)
    } catch (error) {
      setFailed((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-labelledby="email-settings-heading"
    >
      <h2 id="email-settings-heading" className="text-lg font-semibold">
        Email notifications
      </h2>
      <p className="text-sm text-muted-foreground">
        Sign-in and security emails always come, and so do emails someone sends you.
      </p>
      {failed && <Alert variant="destructive">{failed}</Alert>}
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Emails to get</legend>
        {EMAIL_TYPES.map((type) => (
          <label key={type} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={!off.has(type)}
              aria-describedby={`${type}-hint`}
              onChange={(event) => {
                const next = new Set(off)
                if (event.target.checked) next.delete(type)
                else next.add(type)
                setOff(next)
                setSaved(false)
              }}
            />
            <span>
              <span className="block font-medium">{OPTIONS[type].label}</span>
              <span id={`${type}-hint`} className="block text-muted-foreground">
                {OPTIONS[type].hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button type="submit" aria-disabled={saving}>
        {saving ? 'Saving…' : 'Save email settings'}
      </Button>
      <p role="status" className="text-sm empty:hidden">
        {saved ? 'Saved.' : ''}
      </p>
    </form>
  )
}
