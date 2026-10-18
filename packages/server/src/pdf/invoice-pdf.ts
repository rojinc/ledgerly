import { addDays, type LocalDate } from '@ledgerly/core/dates/local-date'
import { formatMoney } from '@ledgerly/core/money/format'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import pdfmake from 'pdfmake'
import vfs from 'pdfmake/build/vfs_fonts.js'
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'

// Roboto ships inside pdfmake as base64 in a JavaScript file, so esbuild bundles it like any
// other module and the function needs no font files on disk. In Node, pdfmake takes fonts only
// by file name, so they go into its in-memory file system (not in its types).
const { virtualfs } = pdfmake as unknown as {
  virtualfs: { writeFileSync(name: string, content: Buffer): void }
}
const fonts = { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf' }
for (const file of Object.values(fonts)) {
  virtualfs.writeFileSync(file, Buffer.from(vfs[file] as string, 'base64'))
}
pdfmake.setFonts({ Roboto: fonts })
// An invoice uses only the data passed in: never fetch a URL or read a local file.
pdfmake.setUrlAccessPolicy(() => false)
pdfmake.setLocalAccessPolicy(() => false)

const LOCALE = 'en-AU'
const MUTED = '#616e7c'
// For lines with no description. `kind` is a plain string in old snapshots, so unknown ones print as is.
const KIND_LABELS: Record<string, string> = {
  shift: 'Shift',
  expense: 'Expense',
  bill: 'Bill',
  payment: 'Payment',
  loan: 'Loan',
  income: 'Income',
  adjustment: 'Adjustment',
}

type Line = StatementSnapshot['lines'][number]

/**
 * The statement row's number and issue date, which the snapshot doesn't hold. The due date
 * is worked out here as `issuedOn` plus the payment terms (statements.md#2-finalize, step 7),
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
          { text: business.businessName ?? issuer.name, style: 'issuer' },
          ...present([
            business.abn &&
              `ABN ${business.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4')}`,
            business.address,
            business.email,
            business.phone,
          ]),
        ],
        {
          width: 'auto',
          stack: [
            { text: 'INVOICE', style: 'title' },
            {
              layout: 'noBorders',
              table: {
                body: [
                  field('Number', details.displayNumber),
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
    { text: recipient.name, bold: true },
    ...recipient.emails,
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
          lineText(line),
          line.shift ? hoursText(line.shift.minutes) : '',
          line.shift ? `${money(line.shift.rateCents)}/h` : '',
          money(owed(line)),
        ]),
        ['Total work and charges', money(total(charges))],
      ),
    )
  }
  if (credits.length > 0) {
    content.push(
      heading('Payments received and deductions'),
      table(
        [60, '*', 70],
        ['Date', 'Description', 'Amount'],
        credits.map((line) => [formatDate(line.date), lineText(line), money(owed(line))]),
        ['Total payments and deductions', money(total(credits))],
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
        records.map((line) => [formatDate(line.date), lineText(line), money(line.totalCents)]),
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
          `${terms(invoice.paymentTermsDays)} Please pay by ${formatDate(dueOn)}, with ${details.displayNumber} as the reference.`,
        ]),
      ],
    })
  }
  if (business.invoiceNotes) {
    // Not unbreakable: notes taller than a page would be dropped, heading and all.
    content.push(heading('Notes'), business.invoiceNotes)
  }

  const doc: TDocumentDefinitions = {
    info: { title: `Invoice ${details.displayNumber}`, creator: 'Ledgerly', producer: 'Ledgerly' },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.15 },
    styles: {
      issuer: { fontSize: 14, bold: true, margin: [0, 0, 0, 4] },
      title: { fontSize: 20, bold: true, alignment: 'right', margin: [0, 0, 0, 6] },
      heading: { fontSize: 12, bold: true, margin: [0, 14, 0, 4] },
      balance: { fontSize: 14, bold: true },
    },
    // A heading never ends a page: it moves to the next page with what follows it.
    pageBreakBefore: (node, nodes) =>
      node.headlineLevel === 1 && nodes.getFollowingNodesOnPage().length === 0,
    footer: (page, pages) => ({
      text: `${details.displayNumber} · page ${page} of ${pages}`,
      alignment: 'center',
      fontSize: 8,
      color: MUTED,
    }),
    content,
  }
  return pdfmake.createPdf(doc).getBuffer()
}

/** The strings that are set; pdfmake can't draw `undefined`. */
function present(texts: (string | false | undefined)[]): string[] {
  return texts.filter((text): text is string => Boolean(text))
}

// A word pdfmake can't break widens its column until the amounts fall off the page, so long
// runs without a space (a pasted reference or URL) get a zero-width space every 20 characters.
function lineText(line: Line): string {
  const text = line.description || KIND_LABELS[line.kind] || line.kind
  return text.replace(/\S{20}(?=\S)/g, '$&\u200B')
}

function heading(text: string): Content {
  return { text, style: 'heading', headlineLevel: 1 }
}

/** `7:30` for 450 minutes: exact, where decimal hours would print 20 minutes as 0.33. */
function hoursText(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

function terms(days: number): string {
  if (days === 0) return 'Payment terms: due on receipt.'
  return `Payment terms: ${days} ${days === 1 ? 'day' : 'days'}.`
}

/** A table of date, description, then numbers, which are right-aligned. */
function table(
  widths: (number | string)[],
  header: string[],
  rows: string[][],
  total?: [label: string, amount: string],
): Content {
  const row = (texts: string[], style: { bold?: boolean; color?: string } = {}): TableCell[] =>
    texts.map((text, index) => ({
      text,
      ...style,
      alignment: index >= 2 ? 'right' : 'left',
    }))
  const body = [row(header, { bold: true, color: MUTED }), ...rows.map((texts) => row(texts))]
  if (total) {
    // A spanned cell still needs its empty placeholders.
    body.push([
      { text: total[0], bold: true, colSpan: widths.length - 1 },
      ...Array.from({ length: widths.length - 2 }, () => ({})),
      { text: total[1], bold: true, alignment: 'right' },
    ])
  }
  return { layout: 'lightHorizontalLines', table: { headerRows: 1, widths, body } }
}

function field(label: string, value: string): TableCell[] {
  return [
    { text: label, color: MUTED },
    { text: value, bold: true },
  ]
}

/** One label with its amount on the right. */
function amountLine(label: string, amount: string, style?: string): Content {
  return {
    columns: [label, { text: amount, width: 'auto' }],
    style,
    margin: [0, 14, 0, 0],
  }
}

/** `16 Oct 2026`, read from the `YYYY-MM-DD` parts and shown in UTC, so it never shifts a day. */
function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(Date.UTC(year, month - 1, day))
}
