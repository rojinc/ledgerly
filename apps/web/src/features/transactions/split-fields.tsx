import type { Members } from '@ledgerly/core/generated/rows'
import type { Share } from '@ledgerly/core/ledger/build-shares'
import { formatMoney } from '@ledgerly/core/money/format'
import type { FieldError, UseFormRegisterReturn } from 'react-hook-form'
import { SelectField } from '../../ui/field'
import { livesThere } from './house-expense'

// Payer and split controls for house expenses (#180), and for bills and receipts later (#44, #42).
// Each takes the members and its field's `register()` result, so any form can use it.

type Member = Pick<Members, 'personId' | 'displayName' | 'joinedOn' | 'leftOn'>

/** Who paid it all: one of the group's members. */
export function PaidByField({
  members,
  field,
  error,
}: {
  members: readonly Member[]
  field: UseFormRegisterReturn
  error?: FieldError
}) {
  return (
    <SelectField id="paidBy" label="Paid by" error={error} {...field}>
      {members.map((member) => (
        <option key={member.personId} value={member.personId}>
          {member.displayName}
        </option>
      ))}
    </SelectField>
  )
}

/**
 * One checkbox per member to split it equally between. Members not living there on `date` are
 * listed too (they may still share it), with a line saying so.
 */
export function SplitBetweenField({
  members,
  date,
  field,
  error,
}: {
  members: readonly Member[]
  date: string
  field: UseFormRegisterReturn
  error?: FieldError
}) {
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={error ? 'splitBetween-error' : undefined}
    >
      <legend className="mb-1 text-sm font-medium">Split equally between</legend>
      {members.map((member) => {
        const away = !livesThere(member, date)
        const hint = `splitBetween-${member.personId}-hint`
        // On each box too: focus goes to the first one after a refused Add.
        const describedBy = [away && hint, error && 'splitBetween-error'].filter(Boolean).join(' ')
        return (
          <label key={member.personId} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              value={member.personId}
              className="mt-1"
              aria-invalid={Boolean(error)}
              aria-describedby={describedBy || undefined}
              {...field}
            />
            <span className="min-w-0 break-words">
              <span className="block">{member.displayName}</span>
              {away && (
                <span id={hint} className="block text-muted-foreground">
                  not living here on this date
                </span>
              )}
            </span>
          </label>
        )
      })}
      {error && (
        <p id="splitBetween-error" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </fieldset>
  )
}

/** Each involved person's part, from core `buildShares()`, in words. */
export function SharePreview({
  preview,
  members,
  currency,
}: {
  preview: { shares: Share[] } | { error: string } | undefined
  members: readonly Member[]
  currency: string
}) {
  if (!preview) return null
  if ('error' in preview) {
    return (
      <p role="status" className="text-sm text-destructive">
        {preview.error}
      </p>
    )
  }
  const names = new Map(members.map((member) => [member.personId, member.displayName]))
  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-1">
      <h2 id="preview-heading" className="text-sm font-medium">
        Each person’s part
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {preview.shares.map((share) => (
          <li key={share.personId} className="break-words">
            {names.get(share.personId) ?? 'Someone'}:{' '}
            {[
              share.givenCents !== 0 && `paid ${formatMoney(share.givenCents, currency)}`,
              share.receivedCents !== 0 && `share ${formatMoney(share.receivedCents, currency)}`,
            ]
              .filter(Boolean)
              .join(', ')}
          </li>
        ))}
      </ul>
    </section>
  )
}
