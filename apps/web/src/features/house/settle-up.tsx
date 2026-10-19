import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { Transfer } from '@ledgerly/core/settle/suggest-transfers'
import { type ReactNode, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '../../ui/button'
import { useBalances } from '../groups/use-groups'
import { PaymentForm } from './settle-up-form'

/** Which form is open: a suggested transfer's, by its place in the list, or a blank one. */
type Open = { transfer?: Transfer; index: number } | undefined

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
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const balances = useBalances(group.$id)
  const [open, setOpen] = useState<Open>()
  const [recorded, setRecorded] = useState(false)
  const archived = Boolean(group.archivedAt)
  const canRecord = !archived && (me?.role === 'admin' || me?.role === 'member')
  const byPerson = new Map(members.map((member) => [member.personId, member]))
  const name = (personId: string) => {
    const member = byPerson.get(personId)
    if (!member) return 'Someone'
    return personId === me?.personId ? `${member.displayName} (you)` : member.displayName
  }

  function close() {
    const index = open?.index
    flushSync(() => setOpen(undefined))
    const trigger = index === undefined ? undefined : buttons.current.get(index)
    ;(trigger ?? heading.current)?.focus()
  }

  function opener(index: number, transfer?: Transfer) {
    return {
      ref: (button: HTMLButtonElement | null) => {
        if (button) buttons.current.set(index, button)
        else buttons.current.delete(index)
      },
      onClick: () => {
        setRecorded(false)
        setOpen({ transfer, index })
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
    // The viewer first. Someone who moved out stays while they have a balance.
    const people = balances.data.people
      .filter((person) => person.netCents !== 0 || !byPerson.get(person.personId)?.leftOn)
      .sort(
        (a, b) =>
          Number(b.personId === me?.personId) - Number(a.personId === me?.personId) ||
          name(a.personId).localeCompare(name(b.personId)),
      )
    const { transfers } = balances.data
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
        {transfers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Everyone is square.</p>
        ) : (
          // In the order the function returns them.
          <ul className="flex flex-col gap-3">
            {transfers.map((transfer, index) => (
              <li
                // A transfer has no ID; its place is stable until the balances change.
                key={`${transfer.fromPersonId}-${transfer.toPersonId}`}
                className="flex flex-col gap-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {name(transfer.fromPersonId)} pays {name(transfer.toPersonId)}{' '}
                    {formatMoney(transfer.cents, group.currency)}
                  </span>
                  {canRecord && open?.index !== index && (
                    <Button variant="outline" {...opener(index, transfer)}>
                      Record
                    </Button>
                  )}
                </div>
                {open?.index === index && (
                  <PaymentForm
                    group={group}
                    members={members}
                    transfer={transfer}
                    onRecorded={recordedNow}
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

  function recordedNow() {
    setRecorded(true)
    // The transfer may be gone with the new balances: focus goes to the heading.
    flushSync(() => setOpen(undefined))
    heading.current?.focus()
  }

  const blank = -1
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 ref={heading} id={headingId} tabIndex={-1} className="font-medium outline-none">
        Settle up
      </h2>
      {/* Mounted from the start, so the announcement is read out when it changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {recorded && 'Payment recorded.'}
      </p>
      {body}
      {canRecord &&
        (open?.index === blank ? (
          <PaymentForm group={group} members={members} onRecorded={recordedNow} onCancel={close} />
        ) : (
          <Button variant="outline" className="self-start" {...opener(blank)}>
            Record a payment
          </Button>
        ))}
      {!archived && !canRecord && (
        <p className="text-sm text-muted-foreground">A housemate can record a payment for you.</p>
      )}
    </section>
  )
}
