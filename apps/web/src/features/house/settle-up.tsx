import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { Transfer } from '@ledgerly/core/settle/suggest-transfers'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '../../ui/button'
import { useBalances } from '../groups/use-groups'
import { PaymentForm } from './settle-up-form'

/** The open form: a suggested transfer's, by who pays whom, or the blank one. */
const BLANK = 'blank'

/** A transfer has no ID, but the function suggests at most one per pair. */
const keyOf = (transfer: Transfer) => `${transfer.fromPersonId}>${transfer.toPersonId}`

/** "Alice is owed $54.80", "Cara owes $45.20", "Bob is square". */
export function balanceLine(name: string, net: number, currency: string): string {
  const amount = formatMoney(Math.abs(net), currency)
  return net > 0
    ? `${name} is owed ${amount}`
    : net < 0
      ? `${name} owes ${amount}`
      : `${name} is square`
}

/**
 * Each housemate's balance and the fewest payments that settle the house, both from
 * `ledger GET /groups/{id}/balances`, never summed here (ledger.md#settle-up-suggested-transfers).
 * Admins and members record a payment once it has happened outside the app (D-014).
 */
export function SettleUp({
  group,
  me,
  members,
}: {
  group: Groups
  me: Members | null
  members: Members[]
}) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const balances = useBalances(group.$id)
  const [open, setOpen] = useState<string>()
  const [notice, setNotice] = useState('')
  const archived = Boolean(group.archivedAt)
  const canRecord = !archived && (me?.role === 'admin' || me?.role === 'member')
  const transfers = balances.data?.transfers
  // The open form, while it still can be: the caller may stop being able to record (archived,
  // or a new role), and a refetch may drop its transfer (someone settled it meanwhile).
  const shown =
    open && canRecord && (open === BLANK || transfers?.some((transfer) => keyOf(transfer) === open))
      ? open
      : undefined
  useEffect(() => {
    if (!open || shown) return
    setOpen(undefined)
    // The house page says when the role changes or the house is archived.
    if (canRecord) setNotice('The suggested payments changed, so that form was closed.')
    if (document.activeElement === document.body) heading.current?.focus()
  }, [open, shown, canRecord])
  const byPerson = new Map(members.map((member) => [member.personId, member]))
  const name = (personId: string) => {
    const member = byPerson.get(personId)
    if (!member) return 'Someone'
    return personId === me?.personId ? `${member.displayName} (you)` : member.displayName
  }

  function close() {
    const key = open
    flushSync(() => setOpen(undefined))
    const trigger = key === undefined ? undefined : buttons.current.get(key)
    ;(trigger ?? heading.current)?.focus()
  }

  function recorded() {
    setNotice('Payment recorded.')
    // The transfer may be gone with the new balances: focus goes to the heading.
    flushSync(() => setOpen(undefined))
    heading.current?.focus()
  }

  function opener(key: string) {
    return {
      ref: (button: HTMLButtonElement | null) => {
        if (button) buttons.current.set(key, button)
        else buttons.current.delete(key)
      },
      onClick: () => {
        setNotice('')
        setOpen(key)
      },
    }
  }

  let body: ReactNode
  if (!balances.data) {
    body = balances.isError ? (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-destructive">
          We couldn’t load the balances.
        </p>
        <Button variant="outline" onClick={() => balances.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  } else {
    // The viewer first. Someone else who moved out stays while they have a balance.
    const people = balances.data.people
      .filter(
        (person) =>
          person.personId === me?.personId ||
          person.netCents !== 0 ||
          !byPerson.get(person.personId)?.leftOn,
      )
      .sort(
        (a, b) =>
          Number(b.personId === me?.personId) - Number(a.personId === me?.personId) ||
          name(a.personId).localeCompare(name(b.personId)),
      )
    body = (
      <>
        {people.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {people.map((person) => (
              <li key={person.personId} className="px-4 py-3">
                {balanceLine(name(person.personId), person.netCents, group.currency)}
              </li>
            ))}
          </ul>
        )}
        <h3 className="text-sm font-medium">Suggested payments</h3>
        {balances.data.transfers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Everyone is square.</p>
        ) : (
          // In the order the function returns them.
          <ul className="flex flex-col gap-3">
            {balances.data.transfers.map((transfer) => (
              <li key={keyOf(transfer)} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {name(transfer.fromPersonId)} pays {name(transfer.toPersonId)}{' '}
                    {formatMoney(transfer.cents, group.currency)}
                  </span>
                  {canRecord && shown !== keyOf(transfer) && (
                    <Button variant="outline" {...opener(keyOf(transfer))}>
                      Record
                    </Button>
                  )}
                </div>
                {shown === keyOf(transfer) && (
                  <PaymentForm
                    group={group}
                    members={members}
                    personId={me?.personId ?? ''}
                    // Prefills the form once: a refetch doesn't change what's typed.
                    transfer={transfer}
                    onRecorded={recorded}
                    onCancel={close}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 ref={heading} id={headingId} tabIndex={-1} className="font-medium outline-none">
        Settle up
      </h2>
      {/* Mounted from the start, so the announcement is read out when it changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
      {body}
      {canRecord &&
        (shown === BLANK ? (
          <PaymentForm
            group={group}
            members={members}
            personId={me?.personId ?? ''}
            onRecorded={recorded}
            onCancel={close}
          />
        ) : (
          <Button variant="outline" className="self-start" {...opener(BLANK)}>
            Record a payment
          </Button>
        ))}
      {!archived && !canRecord && (
        <p className="text-sm text-muted-foreground">A housemate can record a payment for you.</p>
      )}
    </section>
  )
}
