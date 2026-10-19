import type { Statements } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import type { ReactNode } from 'react'
import { invoiceSections, type Line } from './invoice-sections'

// For lines with no description, as the PDF names them.
const KIND_LABELS: Record<string, string> = {
  shift: 'Shift',
  expense: 'Expense',
  bill: 'Bill',
  payment: 'Payment',
  loan: 'Loan',
  income: 'Income',
  adjustment: 'Adjustment',
}

/** A local date as `22 Oct 2026`, built in UTC so the browser's time zone never moves it. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(year, month - 1, day))
}

function lineText(line: Line): string {
  return line.description || KIND_LABELS[line.kind] || line.kind
}

/** `5 h 30 min`, `8 h` or `45 min`. */
function hoursText(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours > 0 && `${hours} h`, (rest > 0 || hours === 0) && `${rest} min`]
    .filter(Boolean)
    .join(' ')
}

/** As the PDF words them (packages/server/src/pdf/invoice-pdf.ts). */
function terms(days: number): string {
  if (days === 0) return 'Payment terms: due on receipt.'
  return `Payment terms: ${days} ${days === 1 ? 'day' : 'days'}.`
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  )
}

function LineTable({
  lines,
  amount,
  money,
  total,
}: {
  lines: Line[]
  amount: (line: Line) => number
  money: (cents: number) => string
  total?: [label: string, amount: string]
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-normal">Date</th>
            <th className="py-1 pr-2 font-normal">Description</th>
            <th className="py-1 text-right font-normal">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.transactionId} className="border-t border-border align-top">
              <td className="py-1 pr-2 whitespace-nowrap">{formatDate(line.date)}</td>
              <td className="py-1 pr-2 break-words">
                {lineText(line)}
                {/* Under the description rather than in columns of their own, to fit 375 px. */}
                {line.shift && (
                  <span className="block text-muted-foreground">
                    {hoursText(line.shift.minutes)} at {money(line.shift.rateCents)}/h
                  </span>
                )}
              </td>
              <td className="py-1 text-right whitespace-nowrap tabular-nums">
                {money(amount(line))}
              </td>
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="py-1 pr-2" colSpan={2}>
                {total[0]}
              </td>
              <td className="py-1 text-right tabular-nums">{total[1]}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

/**
 * An invoice laid out as its PDF is (statements.md#invoice-pdf-layout-employer). A draft has no
 * number or dates yet: those come when it's finalized.
 */
export function InvoiceView({
  statement,
  snapshot,
}: {
  statement: Statements
  snapshot: StatementSnapshot
}) {
  const { issuer, recipient, invoice } = snapshot
  if (!issuer || !recipient || !invoice) {
    return <p className="text-muted-foreground">This statement isn’t an invoice.</p>
  }
  const money = (cents: number) => formatMoney(cents, snapshot.group.currency)
  const { openingCents, owed, charges, credits, records } = invoiceSections(
    snapshot,
    issuer.personId,
  )
  const sum = (lines: Line[]) => lines.reduce((total, line) => total + owed(line), 0)
  const business = issuer.business
  const balance = invoice.balanceDueCents
  return (
    <article
      aria-label={statement.displayNumber ? `Invoice ${statement.displayNumber}` : 'Draft invoice'}
      className="flex flex-col gap-5 rounded-md border border-border p-4"
    >
      <div className="flex flex-wrap justify-between gap-4">
        <div className="min-w-0 text-sm">
          <p className="text-base font-semibold break-words">
            {business.businessName ?? issuer.name}
          </p>
          {business.abn && (
            <p>ABN {business.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4')}</p>
          )}
          {business.address && <p className="break-words">{business.address}</p>}
          {business.email && <p className="break-words">{business.email}</p>}
          {business.phone && <p>{business.phone}</p>}
        </div>
        <div className="text-sm">
          <p className="text-lg font-semibold">
            {statement.displayNumber ? 'INVOICE' : 'DRAFT INVOICE'}
          </p>
          <dl className="grid grid-cols-[auto_auto] gap-x-3">
            <dt className="text-muted-foreground">Number</dt>
            <dd>{statement.displayNumber ?? 'Given when finalized'}</dd>
            {statement.issuedOn && (
              <>
                <dt className="text-muted-foreground">Issued</dt>
                <dd>{formatDate(statement.issuedOn)}</dd>
              </>
            )}
            {statement.dueOn && (
              <>
                <dt className="text-muted-foreground">Due</dt>
                <dd>{formatDate(statement.dueOn)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Period</dt>
            <dd>
              {formatDate(snapshot.period.start)} – {formatDate(snapshot.period.end)}
            </dd>
          </dl>
        </div>
      </div>
      <Section title="Bill to">
        <p className="text-sm">
          <span className="block font-medium break-words">{recipient.name}</span>
          {recipient.emails.map((email) => (
            <span key={email} className="block break-words">
              {email}
            </span>
          ))}
        </p>
      </Section>
      <p className="flex justify-between gap-3 text-sm">
        <span>Opening balance (from the previous invoice)</span>
        <span className="tabular-nums">{money(openingCents)}</span>
      </p>
      {charges.length > 0 && (
        <Section title="Work and charges">
          <LineTable
            lines={charges}
            amount={owed}
            money={money}
            total={['Total work and charges', money(sum(charges))]}
          />
        </Section>
      )}
      {credits.length > 0 && (
        <Section title="Payments received and deductions">
          <LineTable
            lines={credits}
            amount={owed}
            money={money}
            total={['Total payments and deductions', money(sum(credits))]}
          />
        </Section>
      )}
      <p className="flex justify-between gap-3 border-t border-border pt-3 text-lg font-semibold">
        <span>Balance due</span>
        <span className="tabular-nums">{money(balance)}</span>
      </p>
      {balance < 0 && (
        <p className="text-sm">
          You have a credit of {money(-balance)}, so there is nothing to pay.
        </p>
      )}
      {balance === 0 && <p className="text-sm">There is nothing to pay this time.</p>}
      {records.length > 0 && (
        <Section title="For your records">
          <p className="text-sm text-muted-foreground">
            Not charged: these don’t change the balance due.
          </p>
          <LineTable lines={records} amount={(line) => line.totalCents} money={money} />
        </Section>
      )}
      {balance > 0 && (
        <Section title="How to pay">
          <div className="text-sm">
            {business.bank && (
              <p className="break-words">
                Bank transfer: {business.bank.accountName}, BSB{' '}
                {business.bank.bsb.replace(/^(\d{3})(\d{3})$/, '$1-$2')}, account{' '}
                {business.bank.accountNumber}
              </p>
            )}
            {business.payId && <p className="break-words">PayID: {business.payId}</p>}
            <p>
              {terms(invoice.paymentTermsDays)}
              {statement.dueOn && statement.displayNumber
                ? ` Please pay by ${formatDate(statement.dueOn)}, with ${statement.displayNumber} as the reference.`
                : ''}
            </p>
          </div>
        </Section>
      )}
      {business.invoiceNotes && (
        <Section title="Notes">
          <p className="text-sm whitespace-pre-line break-words">{business.invoiceNotes}</p>
        </Section>
      )}
    </article>
  )
}
