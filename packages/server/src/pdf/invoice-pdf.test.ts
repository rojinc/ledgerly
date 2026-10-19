import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parseLocalDate } from '@ledgerly/core/dates/local-date'
import type { BusinessDetails } from '@ledgerly/core/schemas/identity'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { buildStatementSnapshot, type SnapshotInput } from '@ledgerly/core/statements/snapshot'
import { extractText, getDocumentProxy } from 'unpdf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFontReader } from './fonts'
import { type InvoiceDetails, renderInvoicePdf } from './invoice-pdf'
import { breakable } from './layout'

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

// Where the build finds each font file (scripts/build-functions.mjs).
const FONT_PATHS: Record<string, string | URL> = {
  'NotoSansCJKsc-Regular.otf': new URL('../../fonts/NotoSansCJKsc-Regular.otf', import.meta.url),
  'NotoEmoji_400Regular.ttf': createRequire(import.meta.url).resolve(
    '@expo-google-fonts/noto-emoji/400Regular/NotoEmoji_400Regular.ttf',
  ),
}
// The font files each test reads, in order, as a new instance would.
let reads: string[] = []
beforeEach(() => {
  reads = []
  useFontReader((file) => {
    reads.push(file)
    return readFileSync(FONT_PATHS[file] as string | URL)
  })
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

  // breakable() puts a zero-width space every 20 characters; between the halves of an emoji or
  // a CJK letter past U+FFFF, both would print as �.
  it('wraps a long word of emoji or rare CJK without cutting a character', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const description = `Lunch${'🍔🍟🥤'.repeat(4)} ${'x'.repeat(19)}𠮷野家`
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      lines: [
        line(
          '2026-10-02',
          'expense',
          4000,
          [share('worker', 4000, 0), share('employer', 0, 4000)],
          { description },
        ),
      ],
    })
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    // The line may wrap at the break it put in.
    expect(text.replace(/[\s\u200B]/g, '')).toContain(description.replace(/\s/g, ''))
    expect(text).not.toContain('�')
    expect(warn).not.toHaveBeenCalled()
  })

  it('prints every line of long notes, with the heading on the page of the first', async () => {
    const notes = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join('\n')
    const snapshot = goldenSnapshot({ ...fullBusiness, invoiceNotes: notes })
    const pages = await pageTexts(await renderInvoicePdf(snapshot, details))
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.some((page) => page.includes('Notes Line 1 Line 2'))).toBe(true)
    expect(pages.join(' ')).toContain('Line 79 Line 80')
    // The number's runs print in every page's footer.
    expect(pages.at(-1)).toContain(`INV-0010 · page ${pages.length} of ${pages.length}`)
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

  it('prints a character no font has as �, so Bill to is never blank (#269)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snapshot = buildStatementSnapshot({
      ...goldenInput({ ...fullBusiness, businessName: 'Café Ngọc' }),
      recipient: { personId: 'employer', name: 'ร้าน Pty Ltd', emails: ['accounts@acme.example'] },
    })
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain('Bill to ���� Pty Ltd accounts@acme.example')
    expect(text).toMatch(/^Café Ngọc /)
    // The count only, never the text.
    expect(warn.mock.calls).toEqual([['invoice PDF: 4 characters print as U+FFFD']])
    expect(reads).toEqual([])
  })

  it('prints Chinese, Japanese, Korean and emoji in their own fonts (#270)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snapshot = buildStatementSnapshot({
      ...goldenInput({
        ...fullBusiness,
        businessName: '山田太郎 カタカナ',
        invoiceNotes: 'Thanks 😀',
      }),
      lines: [
        line(
          '2026-10-02',
          'expense',
          4000,
          [share('worker', 4000, 0), share('employer', 0, 4000)],
          {
            description: '김민준 한국어',
          },
        ),
      ],
      recipient: { personId: 'employer', name: '张三 Pty Ltd', emails: ['accounts@acme.example'] },
    })
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toMatch(/^山田太郎 カタカナ /)
    expect(text).toContain('Bill to 张三 Pty Ltd accounts@acme.example')
    expect(text).toContain('2 Oct 2026 김민준 한국어 $40.00')
    expect(text).toContain('Notes Thanks 😀')
    // Nothing printed as �, or left out (an unknown glyph extracts as U+0000).
    expect(text).not.toContain('�')
    expect(text).not.toContain('\u0000')
    expect(warn).not.toHaveBeenCalled()
    expect(reads).toEqual(['NotoSansCJKsc-Regular.otf', 'NotoEmoji_400Regular.ttf'])
  })

  it('reads no font file for an invoice Roboto can print', async () => {
    await renderInvoicePdf(goldenSnapshot(), details)
    expect(reads).toEqual([])
  })

  it('reads a font file once while the instance is warm', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      recipient: { personId: 'employer', name: '张三 Pty Ltd', emails: ['accounts@acme.example'] },
    })
    await renderInvoicePdf(snapshot, details)
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain('Bill to 张三 Pty Ltd')
    expect(reads).toEqual(['NotoSansCJKsc-Regular.otf'])
  })

  it('reads a font file again after a read fails', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput(),
      recipient: { personId: 'employer', name: '张三 Pty Ltd', emails: ['accounts@acme.example'] },
    })
    useFontReader((file) => {
      reads.push(file)
      if (reads.length === 1) throw new Error('EIO')
      return readFileSync(FONT_PATHS[file] as string | URL)
    })
    await expect(renderInvoicePdf(snapshot, details)).rejects.toThrow('EIO')
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toContain('Bill to 张三 Pty Ltd')
    expect(reads).toEqual(['NotoSansCJKsc-Regular.otf', 'NotoSansCJKsc-Regular.otf'])
  })

  // Roboto has no Ṣ, but has S and U+0323 (#269, #297).
  it('prints a letter Roboto has only as base + mark from its parts', async () => {
    const snapshot = buildStatementSnapshot(goldenInput({ businessName: 'Ṣàdé Services' }))
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toMatch(/^S\u0323àdé Services /)
    expect(reads).toEqual([])
  })

  // Thai is in no font, so each text shows �; Chinese prints, in Noto Sans CJK.
  it.each([
    ['marks', 'ก', '�', 11],
    ['prints', '山', '山', 0],
  ])('%s every text it prints from the profile and the snapshot', async (_, char, shown, count) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snapshot = buildStatementSnapshot({
      ...goldenInput({
        businessName: `${char} Services`,
        address: `1 ${char} St`,
        email: 'sam@example.com',
        bank: { accountName: `${char} Lee`, bsb: '062000', accountNumber: '12345678' },
        payId: `${char}@example.com`,
        invoiceNotes: `Thanks ${char}`,
      }),
      lines: [
        shift('2026-10-01', 12500),
        line(
          '2026-10-02',
          'expense',
          4000,
          [share('worker', 4000, 0), share('employer', 0, 4000)],
          {
            description: `${char} supplies`,
          },
        ),
        line(
          '2026-10-03',
          'payment',
          1000,
          [share('employer', 1000, 0), share('worker', 0, 1000)],
          {
            description: `${char} transfer`,
          },
        ),
        // A kind from an older snapshot, printed as stored.
        line('2026-10-04', char, 3000, [share('employer', 3000, 3000)]),
      ],
      recipient: { personId: 'employer', name: `${char} Co`, emails: [`${char}@acme.example`] },
    })
    const text = await pdfText(
      await renderInvoicePdf(snapshot, { ...details, displayNumber: `${char}-0010` }),
    )
    for (const expected of [
      `${shown} Services`,
      `1 ${shown} St`,
      `Number ${shown}-0010`,
      `Bill to ${shown} Co ${shown}@acme.example`,
      `2 Oct 2026 ${shown} supplies`,
      `3 Oct 2026 ${shown} transfer`,
      `4 Oct 2026 ${shown} $30.00`,
      `Bank transfer: ${shown} Lee,`,
      `PayID: ${shown}@example.com`,
      `with ${shown}-0010 as the reference.`,
      `Notes Thanks ${shown}`,
      `${shown}-0010 · page 1 of`,
    ]) {
      expect(text).toContain(expected)
    }
    // Nothing left that the font would leave out (an unknown glyph extracts as U+0000).
    expect(text).not.toContain('\u0000')
    expect(text).not.toContain(count > 0 ? char : '�')
    // Once for the invoice number, wherever it prints.
    expect(warn.mock.calls).toEqual(
      count > 0 ? [[`invoice PDF: ${count} characters print as U+FFFD`]] : [],
    )
  })

  it('logs nothing when Roboto can draw it all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderInvoicePdf(goldenSnapshot(), details)
    expect(warn).not.toHaveBeenCalled()
  })

  it('prints decomposed accents composed, not as �', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const businessName = 'Nguyễn Thị Ánh'.normalize('NFD')
    const snapshot = buildStatementSnapshot(goldenInput({ businessName }))
    const text = await pdfText(await renderInvoicePdf(snapshot, details))
    expect(text).toMatch(/^Nguyễn Thị Ánh /)
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses a divide', async () => {
    const snapshot = { ...goldenSnapshot(), issuer: undefined }
    await expect(renderInvoicePdf(snapshot, details)).rejects.toThrow('needs an invoice snapshot')
  })
})

describe('breakable', () => {
  // Each is one character to a reader, made of more than one UTF-16 unit or code point.
  it.each([
    ['an emoji', '😀'],
    ['a family', '👨‍👩‍👧'],
    ['a flag', '🇦🇺'],
    ['a keycap', '1️⃣'],
    ['a letter and its mark', 'ṣ'],
  ])('keeps %s whole as the 20th character', (_, character) => {
    const word = `${'x'.repeat(19)}${character}`
    expect(breakable(`${word}y`)).toBe(`${word}​y`)
  })
})
