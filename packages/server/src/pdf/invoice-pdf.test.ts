import { writeFileSync } from 'node:fs'
import { parseLocalDate } from '@ledgerly/core/dates/local-date'
import type { BusinessDetails } from '@ledgerly/core/schemas/identity'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { buildStatementSnapshot, type SnapshotInput } from '@ledgerly/core/statements/snapshot'
import { extractText, getDocumentProxy } from 'unpdf'
import { describe, expect, it } from 'vitest'
import { type InvoiceDetails, renderInvoicePdf } from './invoice-pdf'

type Line = StatementSnapshot['lines'][number]

const d = parseLocalDate
let nextId = 0
const line = (
  date: string,
  kind: string,
  totalCents: number,
  shares: Line['shares'],
  extra: Partial<Line> = {},
): Line => ({
  transactionId: `tx${String(nextId++).padStart(3, '0')}`,
  date: d(date),
  kind,
  description: '',
  totalCents,
  shares,
  ...extra,
})
const share = (personId: string, givenCents: number, receivedCents: number) => ({
  personId,
  givenCents,
  receivedCents,
})
const shift = (date: string, cents: number) =>
  line(date, 'shift', cents, [share('worker', cents, 0), share('employer', 0, cents)], {
    description: 'Thursday shift',
    shift: { minutes: (cents / 2500) * 60, rateCents: 2500 },
  })

const fullBusiness = {
  businessName: 'Sam Lee Services',
  abn: '51824753556',
  address: '1 Example St, Sydney NSW 2000',
  email: 'sam@example.com',
  phone: '+61 412 345 678',
  bank: { accountName: 'Sam Lee', bsb: '062000', accountNumber: '12345678' },
  payId: 'sam@example.com',
  invoiceNotes: 'Thanks for your business.',
}
// The golden invoice from packages/core/src/statements/snapshot.test.ts (#17): opening 50000,
// shifts 12500 × 4 and 17500, reimbursable 4000, payment received 50000 and a card purchase
// of 12000 (net 0), so the balance due is 71500.
function goldenInput(business: BusinessDetails = fullBusiness): SnapshotInput {
  return {
    group: {
      id: 'grp_employer',
      name: 'Acme',
      type: 'employer',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
    },
    period: { start: d('2026-10-01'), end: d('2026-10-31') },
    people: [
      { personId: 'worker', name: 'Sam' },
      { personId: 'employer', name: 'Acme' },
    ],
    previousClosing: [
      { personId: 'worker', netCents: 50000 },
      { personId: 'employer', netCents: -50000 },
    ],
    lines: [
      shift('2026-10-29', 17500),
      shift('2026-10-01', 12500),
      shift('2026-10-08', 12500),
      shift('2026-10-15', 12500),
      shift('2026-10-22', 12500),
      line('2026-10-10', 'expense', 4000, [share('worker', 4000, 0), share('employer', 0, 4000)], {
        description: 'Cleaning supplies',
      }),
      line('2026-10-20', 'payment', 50000, [
        share('employer', 50000, 0),
        share('worker', 0, 50000),
      ]),
      line('2026-10-12', 'expense', 12000, [share('employer', 12000, 12000)], {
        description: 'Fuel on the company card',
      }),
    ],
    issuer: { personId: 'worker', name: 'Sam', business },
    recipient: { personId: 'employer', name: 'Acme', emails: ['accounts@acme.example'] },
    paymentTermsDays: 14,
    generatedAt: '2026-11-01T00:00:00.000Z',
  }
}
const goldenSnapshot = (business?: BusinessDetails) => buildStatementSnapshot(goldenInput(business))

const details: InvoiceDetails = {
  displayNumber: 'INV-0010',
  issuedOn: d('2026-11-01'),
}

// Each page's text, with whitespace collapsed.
async function pageTexts(pdf: Buffer): Promise<string[]> {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)))
  return text.map((page) => page.replace(/\s+/g, ' '))
}

async function pdfText(pdf: Buffer): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), {
    mergePages: true,
  })
  return text.replace(/\s+/g, ' ')
}

// Text drawn past the right edge of its page, which a reader would never see.
async function textBeyondPage(pdf: Buffer): Promise<string[]> {
  const doc = await getDocumentProxy(new Uint8Array(pdf))
  const beyond: string[] = []
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number)
    const right = page.view[2] as number
    for (const item of (await page.getTextContent()).items) {
      if ('str' in item && item.transform[4] + item.width > right) beyond.push(item.str)
    }
  }
  return beyond
}

describe('renderInvoicePdf', () => {
  it('renders the golden invoice with its number, totals and balance due', async () => {
    const pdf = await renderInvoicePdf(goldenSnapshot(), details)
    // To look at it: INVOICE_PDF_OUT=/tmp/invoice.pdf npm test -w @ledgerly/server
    if (process.env.INVOICE_PDF_OUT) writeFileSync(process.env.INVOICE_PDF_OUT, pdf)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const text = await pdfText(pdf)

    for (const expected of [
      // 1. Header
      'Sam Lee Services',
      'ABN 51 824 753 556',
      '1 Example St, Sydney NSW 2000',
      '+61 412 345 678',
      'INVOICE',
      'Number INV-0010',
      'Issued 1 Nov 2026',
      'Due 15 Nov 2026',
      'Period 1 Oct 2026 – 31 Oct 2026',
      // 2. Bill to
      'Bill to Acme accounts@acme.example',
      // 3. Opening balance
      'Opening balance (from the previous invoice) $500.00',
      // 4. Work and charges, by date
      '1 Oct 2026 Thursday shift 5:00 $25.00/h $125.00',
      '10 Oct 2026 Cleaning supplies $40.00',
      '29 Oct 2026 Thursday shift 7:00 $25.00/h $175.00',
      'Total work and charges $715.00',
      // 5. Payments received, negative
      '20 Oct 2026 Payment -$500.00',
      'Total payments and deductions -$500.00',
      // 6. Balance due
      'Balance due $715.00',
      // 7. For your records, not charged
      "For your records Not charged: these don't change the balance due.",
      '12 Oct 2026 Fuel on the company card $120.00',
      // 8. How to pay
      'Bank transfer: Sam Lee, BSB 062-000, account 12345678',
      'PayID: sam@example.com',
      'Payment terms: 14 days. Please pay by 15 Nov 2026, with INV-0010 as the reference.',
      // 9. Notes
      'Notes Thanks for your business.',
      'INV-0010 · page 1 of',
    ]) {
      expect(text).toContain(expected)
    }
    // The shifts come in date order.
    expect(text.indexOf('1 Oct 2026 Thursday')).toBeLessThan(text.indexOf('8 Oct 2026 Thursday'))
  })

  it('never says tax invoice or GST', async () => {
    const text = await pdfText(await renderInvoicePdf(goldenSnapshot(), details))
    expect(text).not.toMatch(/tax invoice|GST/i)
  })

  it('leaves out business details that are not set and sections with no lines', async () => {
    const snapshot = goldenSnapshot({})
    snapshot.lines = snapshot.lines.filter((l) => l.kind === 'shift')
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    // Without a business name the issuer's own name heads the invoice.
    expect(text).toMatch(/^Sam INVOICE/)
    expect(text).toContain('Total work and charges $675.00')
    for (const missing of [
      'ABN',
      'Bank transfer',
      'PayID',
      'Notes',
      'Payments received',
      'For your records',
    ]) {
      expect(text).not.toContain(missing)
    }
    expect(text).toContain('Payment terms: 14 days.')
  })

  it('shows a first invoice in credit, with nothing to pay', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      previousClosing: [],
      lines: [
        line('2026-10-20', 'payment', 50000, [
          share('employer', 50000, 0),
          share('worker', 0, 50000),
        ]),
        // A kind from an older snapshot, with no description, prints as stored.
        line('2026-10-21', 'advance', 1000, [share('employer', 1000, 0), share('worker', 0, 1000)]),
      ],
    })
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain('Opening balance (from the previous invoice) $0.00')
    expect(text).not.toContain('Work and charges')
    expect(text).toContain('21 Oct 2026 advance -$10.00')
    expect(text).toContain(
      'Balance due -$510.00 You have a credit of $510.00, so there is nothing to pay.',
    )
    expect(text).not.toContain('How to pay')
  })

  it('renders a period with only a card purchase, where the worker has no balance at all', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      previousClosing: [],
      lines: [line('2026-10-12', 'expense', 12000, [share('employer', 12000, 12000)])],
    })
    expect(snapshot.people.map((person) => person.personId)).toEqual(['employer'])
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain('Opening balance (from the previous invoice) $0.00')
    expect(text).toContain('Balance due $0.00 There is nothing to pay this time.')
    expect(text).toContain('12 Oct 2026 Expense $120.00')
  })

  it.each([
    [14, 'Payment terms: 14 days. Please pay by 15 Nov 2026,'],
    [1, 'Payment terms: 1 day. Please pay by 2 Nov 2026,'],
    [0, 'Payment terms: due on receipt. Please pay by 1 Nov 2026,'],
  ])('works out the due date from %i days of terms', async (days, line) => {
    const snapshot = buildStatementSnapshot({ ...goldenInput(), paymentTermsDays: days })
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain(line)
  })

  it('wraps a long word in a description, so no amount falls off the page', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      lines: [
        shift('2026-10-01', 12500),
        line(
          '2026-10-02',
          'expense',
          4000,
          [share('worker', 4000, 0), share('employer', 0, 4000)],
          {
            description: `Order ${'X'.repeat(60)}`,
          },
        ),
      ],
    })
    const pdf = await renderInvoicePdf(snapshot, details)
    expect(await textBeyondPage(pdf)).toEqual([])
    expect(await pdfText(pdf)).toContain('Total work and charges $165.00')
  })

  it('prints every line of long notes, with the heading on the page of the first', async () => {
    const notes = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join('\n')
    const snapshot = goldenSnapshot({ ...fullBusiness, invoiceNotes: notes })
    const pages = await pageTexts(await renderInvoicePdf(snapshot, details))
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.some((page) => page.includes('Notes Line 1 Line 2'))).toBe(true)
    expect(pages.join(' ')).toContain('Line 79 Line 80')
  })

  it('shows hours as h:mm, so 20 minutes reads 0:20', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      lines: [
        line('2026-10-01', 'shift', 1000, [share('worker', 1000, 0), share('employer', 0, 1000)], {
          description: 'Short call',
          shift: { minutes: 20, rateCents: 3000 },
        }),
      ],
    })
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain('1 Oct 2026 Short call 0:20 $30.00/h $10.00')
  })

  it('refuses a divide', async () => {
    const snapshot = { ...goldenSnapshot(), issuer: undefined }
    await expect(renderInvoicePdf(snapshot, details)).rejects.toThrow('needs an invoice snapshot')
  })
})
