import type { Members } from '@ledgerly/core/generated/rows'
import type { Share } from '@ledgerly/core/ledger/build-shares'
import { formatMoney } from '@ledgerly/core/money/format'
import type { ReactNode } from 'react'
import type { FieldError, UseFormRegisterReturn } from 'react-hook-form'
import { SelectField, TextField } from '../../ui/field'
import { livesThere, type SplitMode } from './house-expense'

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

/** Every way a house expense can be split (ledger.md#splits), in words. */
export const SPLIT_MODES: { value: SplitMode; label: string }[] = [
  { value: 'equal', label: 'Equally' },
  { value: 'exact', label: 'By amounts' },
  { value: 'percent', label: 'By percentages' },
  { value: 'weights', label: 'By shares' },
]

/** How it's split: one radio button per mode. */
export function SplitModeField({ field }: { field: UseFormRegisterReturn }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">How to split it</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {SPLIT_MODES.map((mode) => (
          <label key={mode.value} className="flex items-center gap-2 text-sm">
            <input type="radio" value={mode.value} {...field} />
            {mode.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** A group-wide error under a fieldset, tied to it by `id`. */
function GroupError({ id, message }: { id: string; message?: string }) {
  // An alert: the fieldset's description isn't read when focus moves to a field inside it.
  return message ? (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null
}

/** Several people paid: one amount per member; an empty one didn't pay. */
export function PaidAmountsField({
  members,
  currency,
  field,
  errors,
  total,
}: {
  members: readonly Member[]
  currency: string
  field: (personId: string) => UseFormRegisterReturn
  /** By person: what's wrong with their amount. */
  errors: Record<string, string>
  /** What's wrong with the amounts together. */
  total?: string
}) {
  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={total ? 'paid-error' : undefined}>
      <legend className="mb-1 text-sm font-medium">How much each person paid</legend>
      {members.map((member) => {
        const message = errors[member.personId]
        return (
          <TextField
            key={member.personId}
            id={`paid-${member.personId}`}
            inputMode="decimal"
            label={`${member.displayName} paid (${currency})`}
            error={message ? { type: 'validate', message } : undefined}
            {...field(member.personId)}
          />
        )
      })}
      <GroupError id="paid-error" message={total} />
    </fieldset>
  )
}

/**
 * One checkbox per member to split it between. Members not living there on `date` are listed
 * too (they may still share it), with a line saying so. `part` adds a ticked member's own input
 * (their amount, percentage or shares) when the split isn't equal.
 */
export function SplitBetweenField({
  members,
  date,
  field,
  error,
  legend = 'Split equally between',
  part,
}: {
  members: readonly Member[]
  date: string
  field: UseFormRegisterReturn
  error?: FieldError
  legend?: string
  part?: (member: Member) => ReactNode
}) {
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={error ? 'splitBetween-error' : undefined}
    >
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {members.map((member) => {
        const away = !livesThere(member, date)
        return (
          <div key={member.personId} className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                value={member.personId}
                className="mt-1"
                // On each box too: focus goes to the first one after a refused Add. The "not
                // living here" line is in the label already.
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'splitBetween-error' : undefined}
                {...field}
              />
              <span className="min-w-0 break-words">
                <span className="block">{member.displayName}</span>
                {away && (
                  <span className="block text-muted-foreground">not living here on this date</span>
                )}
              </span>
            </label>
            {part?.(member)}
          </div>
        )
      })}
      <GroupError id="splitBetween-error" message={error?.message} />
    </fieldset>
  )
}

/** A ticked member's part of a split that isn't equal. */
export function PartField({
  member,
  mode,
  currency,
  field,
  error,
}: {
  member: Member
  mode: Exclude<SplitMode, 'equal'>
  currency: string
  field: UseFormRegisterReturn
  error?: string
}) {
  const label = {
    exact: `${member.displayName}’s amount (${currency})`,
    percent: `${member.displayName}’s percentage`,
    weights: `${member.displayName}’s shares`,
  }[mode]
  return (
    <div className="pl-6">
      <TextField
        id={`part-${member.personId}`}
        inputMode={mode === 'weights' ? 'numeric' : 'decimal'}
        label={label}
        error={error ? { type: 'validate', message: error } : undefined}
        {...field}
      />
    </div>
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
