import { addDays, type LocalDate } from '@ledgerly/core/dates/local-date'
import { formatMoney } from '@ledgerly/core/money/format'
import { missingGlyphs, printable } from '@ledgerly/core/pdf/pdf-glyphs'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'
import { logProblem } from '../http/log'
import {
  field,
  footer,
  formatDate,
  heading,
  type Line,
  LOCALE,
  lineText,
  MUTED,
  PAGE,
  pdfmake,
  table,
} from './layout'

/**
 * The statement row's number and issue date, which the snapshot doesn't hold. The due date
 * is worked out here as `issuedOn` plus the payment terms (statements.md#2-finalize, step 6),
 * so the PDF's dates and terms always agree.
 */
export type InvoiceDetails = { displayNumber: string; issuedOn: LocalDate }

/**
 * The employer invoice PDF, laid out as statements.md#invoice-pdf-layout-employer says. Lines
 * are sorted into the worker's charges, their payments and deductions, and purchases that
 * don't change what is owed. v1 has no GST, so the PDF is never called a tax invoice.
 */
export async function renderInvoicePdf(
  snapshot: StatementSnapshot,
  details: InvoiceDetails,
): Promise<Buffer> {
  const { issuer, recipient, invoice } = snapshot
  if (!issuer || !recipient || !invoice)
    throw new Error('renderInvoicePdf needs an invoice snapshot')
  const money = (cents: number) => formatMoney(cents, snapshot.group.currency, LOCALE)
  const dueOn = addDays(details.issuedOn, invoice.paymentTermsDays)
  const business = issuer.business
  // Roboto can't draw every script, and pdfmake would leave out what it can't draw, so every text
  // from the snapshot or the profile prints through printable(): a missing character shows as �.
  let replaced = 0
  const print = (text: string) => {
    replaced += missingGlyphs(text).length
    return printable(text)
  }
  const number = print(details.displayNumber)
  const worker = snapshot.people.find((person) => person.personId === issuer.personId)
  const openingCents = worker?.openingCents ?? 0

  // What each line changes in the balance due: the worker's given minus received.
  const owed = (line: Line) =>
    line.shares
      .filter((share) => share.personId === issuer.personId)
      .reduce((sum, share) => sum + share.givenCents - share.receivedCents, 0)
  const charges = snapshot.lines.filter((line) => owed(line) > 0)
  const credits = snapshot.lines.filter((line) => owed(line) < 0)
  const records = snapshot.lines.filter((line) => owed(line) === 0)
  const total = (lines: Line[]) => lines.reduce((sum, line) => sum + owed(line), 0)

  const content: Content[] = [
    {
      columns: [
        [
          { text: print(business.businessName ?? issuer.name), style: 'issuer' },
          ...present([
            business.abn &&
              `ABN ${business.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4')}`,
            business.address,
            business.email,
            business.phone,
          ]).map(print),
        ],
        {
          width: 'auto',
          stack: [
            { text: 'INVOICE', style: 'title' },
            {
              layout: 'noBorders',
              table: {
                body: [
                  field('Number', number),
                  field('Issued', formatDate(details.issuedOn)),
                  field('Due', formatDate(dueOn)),
                  field(
                    'Period',
                    `${formatDate(snapshot.period.start)} – ${formatDate(snapshot.period.end)}`,
                  ),
                ],
              },
            },
          ],
        },
      ],
    },
    heading('Bill to'),
    { text: print(recipient.name), bold: true },
    ...recipient.emails.map(print),
    amountLine('Opening balance (from the previous invoice)', money(openingCents)),
  ]

  if (charges.length > 0) {
    content.push(
      heading('Work and charges'),
      table(
        [60, '*', 40, 60, 70],
        ['Date', 'Description', 'Hours', 'Rate', 'Amount'],
        charges.map((line) => [
          formatDate(line.date),
          print(lineText(line)),
          line.shift ? hoursText(line.shift.minutes) : '',
          line.shift ? `${money(line.shift.rateCents)}/h` : '',
          money(owed(line)),
        ]),
        { total: ['Total work and charges', money(total(charges))] },
      ),
    )
  }
  if (credits.length > 0) {
    content.push(
      heading('Payments received and deductions'),
      table(
        [60, '*', 70],
        ['Date', 'Description', 'Amount'],
        credits.map((line) => [formatDate(line.date), print(lineText(line)), money(owed(line))]),
        { total: ['Total payments and deductions', money(total(credits))] },
      ),
    )
  }
  content.push(amountLine('Balance due', money(invoice.balanceDueCents), 'balance'))
  // The same words as the covering email (email/templates.ts).
  if (invoice.balanceDueCents < 0) {
    content.push(
      `You have a credit of ${money(-invoice.balanceDueCents)}, so there is nothing to pay.`,
    )
  } else if (invoice.balanceDueCents === 0) {
    content.push('There is nothing to pay this time.')
  }
  if (records.length > 0) {
    content.push(
      heading('For your records'),
      // Usually purchases on the employer's card for work: they don't change the balance.
      { text: "Not charged: these don't change the balance due.", color: MUTED },
      table(
        [60, '*', 70],
        ['Date', 'Description', 'Amount'],
        records.map((line) => [
          formatDate(line.date),
          print(lineText(line)),
          money(line.totalCents),
        ]),
      ),
    )
  }
  // How to pay is a few short lines, so it stays on one page.
  if (invoice.balanceDueCents > 0) {
    content.push({
      unbreakable: true,
      stack: [
        heading('How to pay'),
        ...present([
          business.bank &&
            `Bank transfer: ${business.bank.accountName}, BSB ${business.bank.bsb.replace(/^(\d{3})(\d{3})$/, '$1-$2')}, account ${business.bank.accountNumber}`,
          business.payId && `PayID: ${business.payId}`,
          `${terms(invoice.paymentTermsDays)} Please pay by ${formatDate(dueOn)}, with ${number} as the reference.`,
        ]).map(print),
      ],
    })
  }
  if (business.invoiceNotes) {
    // Not unbreakable: notes taller than a page would be dropped, heading and all.
    content.push(heading('Notes'), print(business.invoiceNotes))
  }
  // The count only, never the text (security-and-privacy.md#personal-data).
  if (replaced > 0) logProblem('pdf_characters_replaced', { count: replaced })

  const doc: TDocumentDefinitions = {
    ...PAGE,
    info: { title: `Invoice ${details.displayNumber}`, creator: 'Ledgerly', producer: 'Ledgerly' },
    footer: footer(number),
    content,
  }
  return pdfmake.createPdf(doc).getBuffer()
}

/** The strings that are set; pdfmake can't draw `undefined`. */
function present(texts: (string | false | undefined)[]): string[] {
  return texts.filter((text): text is string => Boolean(text))
}

/** `7:30` for 450 minutes: exact, where decimal hours would print 20 minutes as 0.33. */
function hoursText(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

function terms(days: number): string {
  if (days === 0) return 'Payment terms: due on receipt.'
  return `Payment terms: ${days} ${days === 1 ? 'day' : 'days'}.`
}

/** One label with its amount on the right. */
function amountLine(label: string, amount: string, style?: string): Content {
  return {
    columns: [label, { text: amount, width: 'auto' }],
    style,
    margin: [0, 14, 0, 0],
  }
}
