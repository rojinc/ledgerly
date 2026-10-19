import type { Statements } from '@ledgerly/core/generated/rows'
import { formatMoney, formatNet } from '@ledgerly/core/money/format'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import type { ReactNode } from 'react'
import { formatDate, lineText } from './invoice-view'

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="font-medium">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A closing balance in words: positive is owed to them (ledger.md#balances). */
function closingText(cents: number, money: (cents: number) => string): string {
  if (cents > 0) return `is owed ${money(cents)}`
  if (cents < 0) return `owes ${money(-cents)}`
  return 'settled'
}

/**
 * A house's monthly divide laid out as its PDF is (statements.md#monthly-divide-pdf-layout-house):
 * the people table, the suggested transfers, then the transactions with each person's part.
 * Everything comes from the snapshot, so a final one never changes.
 */
export function DivideView({
  statement,
  snapshot,
}: {
  statement: Statements
  snapshot: StatementSnapshot
}) {
  // Openings, closings and sums are worked out, so they can pass the amount cap.
  const money = (cents: number) => formatNet(cents, snapshot.group.currency)
  // A stored amount (a line's total, a share's paid and part) is within the cap.
  const stored = (cents: number) => formatMoney(cents, snapshot.group.currency)
  const names = new Map(snapshot.people.map((person) => [person.personId, person.name]))
  const name = (personId: string) => names.get(personId) ?? 'Someone'
  const final = statement.status === 'final' || statement.status === 'void'
  return (
    <article
      aria-label={final ? 'Divide' : 'Draft divide'}
      className="flex min-w-0 flex-col gap-5 rounded-md border border-border p-4"
    >
      <div className="flex flex-wrap justify-between gap-4">
        <p className="min-w-0 text-base font-semibold break-words">{snapshot.group.name}</p>
        <div className="text-sm">
          <p className="text-lg font-semibold">{final ? 'DIVIDE' : 'DRAFT DIVIDE'}</p>
          <dl className="grid grid-cols-[auto_auto] gap-x-3">
            <dt className="text-muted-foreground">Period</dt>
            <dd>
              {formatDate(snapshot.period.start)} – {formatDate(snapshot.period.end)}
            </dd>
            {statement.issuedOn && (
              <>
                <dt className="text-muted-foreground">Issued</dt>
                <dd>{formatDate(statement.issuedOn)}</dd>
              </>
            )}
          </dl>
        </div>
      </div>
      <Section id="divide-people" title="Everyone’s balance">
        {/* Scrolls inside the card at 375 px, rather than the page. Focusable, so a keyboard
            can scroll it too (WCAG 2.1.1). */}
        <section
          aria-label="Balances table"
          className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">Name</th>
                <th className="py-1 pr-3 text-right font-normal">Opening</th>
                <th className="py-1 pr-3 text-right font-normal">Paid</th>
                <th className="py-1 pr-3 text-right font-normal">Share</th>
                <th className="py-1 pr-3 text-right font-normal">Closing</th>
                <th className="py-1 font-normal">
                  <span className="sr-only">Closing in words</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.people.map((person) => (
                <tr key={person.personId} className="border-t border-border align-top">
                  <th scope="row" className="py-1 pr-3 text-left font-normal break-words">
                    {person.name}
                  </th>
                  <td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                    {money(person.openingCents)}
                  </td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                    {money(person.givenCents)}
                  </td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                    {money(person.receivedCents)}
                  </td>
                  <td className="py-1 pr-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {money(person.closingCents)}
                  </td>
                  <td className="py-1 whitespace-nowrap">
                    {closingText(person.closingCents, money)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </Section>
      <Section id="divide-transfers" title="To settle up">
        {snapshot.transfers.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {snapshot.transfers.map((transfer) => (
              <li key={`${transfer.fromPersonId}-${transfer.toPersonId}`} className="break-words">
                {name(transfer.fromPersonId)} pays {name(transfer.toPersonId)}{' '}
                <span className="tabular-nums">{money(transfer.cents)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">Everyone is settled up.</p>
        )}
      </Section>
      <Section id="divide-lines" title="Transactions">
        {snapshot.lines.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {snapshot.lines.map((line) => (
              <li key={line.transactionId} className="flex flex-col gap-1 py-2">
                <p className="flex flex-wrap justify-between gap-x-3">
                  <span className="min-w-0 break-words">
                    <span className="text-muted-foreground">{formatDate(line.date)}</span>{' '}
                    {lineText(line)}
                  </span>
                  <span className="tabular-nums">{stored(line.totalCents)}</span>
                </p>
                <ul className="flex flex-col pl-4 text-muted-foreground">
                  {line.shares.map((share) => (
                    <li key={share.personId} className="break-words">
                      {name(share.personId)}:{' '}
                      {[
                        share.givenCents !== 0 && `paid ${stored(share.givenCents)}`,
                        share.receivedCents !== 0 && `share ${stored(share.receivedCents)}`,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'no part'}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">No transactions in this period.</p>
        )}
      </Section>
    </article>
  )
}
