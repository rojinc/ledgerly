import { writeFileSync } from 'node:fs'
import { parseLocalDate } from '@ledgerly/core/dates/local-date'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { buildStatementSnapshot, type SnapshotInput } from '@ledgerly/core/statements/snapshot'
import { extractText, getDocumentProxy } from 'unpdf'
import { describe, expect, it } from 'vitest'
import { renderDividePdf } from './divide-pdf'

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
  transactionId: `tx${String(nextId++).padStart(4, '0')}`,
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

// The golden house divide from packages/core/src/statements/snapshot.test.ts: electricity $270,
// Alice paid, split by days present. Bob came in owing $3 and Erin moved out still owed $3.
function goldenInput(lines?: Line[]): SnapshotInput {
  return {
    group: {
      id: 'grp_house',
      name: '12 Smith St',
      type: 'house',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
    },
    period: { start: d('2026-10-01'), end: d('2026-10-31') },
    people: [
      { personId: 'alice', name: 'Alice' },
      { personId: 'bob', name: 'Bob' },
      { personId: 'cara', name: 'Cara' },
      { personId: 'dan', name: 'Dan' },
      { personId: 'erin', name: 'Erin' },
    ],
    previousClosing: [
      { personId: 'bob', netCents: -300 },
      { personId: 'dan', netCents: 0 },
      { personId: 'erin', netCents: 300 },
    ],
    lines: lines ?? [
      line(
        '2026-10-10',
        'bill',
        27000,
        [share('alice', 27000, 10139), share('bob', 0, 10139), share('cara', 0, 6722)],
        { description: 'Electricity' },
      ),
    ],
    generatedAt: '2026-11-01T00:00:00.000Z',
  }
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

describe('renderDividePdf', () => {
  it('renders the golden divide: people, transfers and transactions, in that order', async () => {
    const pdf = await renderDividePdf(buildStatementSnapshot(goldenInput()))
    // To look at it: DIVIDE_PDF_OUT=/tmp/divide.pdf npm test -w @ledgerly/server
    if (process.env.DIVIDE_PDF_OUT) writeFileSync(process.env.DIVIDE_PDF_OUT, pdf)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const text = await pdfText(pdf)
    const expected = [
      // 1. House, title and period
      '12 Smith St',
      'Divide',
      'Period 1 Oct 2026 – 31 Oct 2026',
      // 2. People: opening, paid, share, closing, and the closing in words
      'People Name Opening Paid Share Closing',
      'Alice $0.00 $270.00 $101.39 $168.61 is owed $168.61',
      'Bob -$3.00 $0.00 $101.39 -$104.39 owes $104.39',
      'Cara $0.00 $0.00 $67.22 -$67.22 owes $67.22',
      // Moved out, still owed: only an opening.
      'Erin $3.00 $0.00 $0.00 $3.00 is owed $3.00',
      // 3. Suggested transfers
      'Suggested transfers',
      'Bob pays Alice $104.39',
      'Cara pays Alice $64.22',
      'Cara pays Erin $3.00',
      // 4. Transactions, each person under the line with what they paid and their share
      'Transactions Date Description Paid Share Total',
      '10 Oct 2026 Electricity Alice $270.00 $101.39 Bob $0.00 $101.39 Cara $0.00 $67.22 $270.00',
      'Divide 1 Oct 2026 – 31 Oct 2026 · page 1 of 1',
    ]
    let from = 0
    for (const part of expected) {
      const at = text.indexOf(part, from)
      expect(at, part).toBeGreaterThanOrEqual(0)
      from = at + part.length
    }
    // Dan has nothing in the period and no opening, so he isn't listed.
    expect(text).not.toContain('Dan')
  })

  it('never says invoice, tax invoice or GST', async () => {
    const text = await pdfText(await renderDividePdf(buildStatementSnapshot(goldenInput())))
    expect(text).not.toMatch(/invoice|GST/i)
  })

  it('says everyone is settled up when nobody owes anything', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput([
        line('2026-10-03', 'expense', 2000, [share('alice', 2000, 1000), share('bob', 0, 1000)]),
        line('2026-10-04', 'payment', 1000, [share('bob', 1000, 0), share('alice', 0, 1000)]),
      ]),
      previousClosing: [],
    })
    const text = await pdfText(await renderDividePdf(snapshot))
    expect(text).toContain('Suggested transfers Everyone is settled up.')
    expect(text).toContain('Alice $0.00 $20.00 $20.00 $0.00 settled')
    // A line without a description is named by its kind.
    expect(text).toContain('3 Oct 2026 Expense Alice $20.00 $10.00 Bob $0.00 $10.00 $20.00')
    expect(text).toContain('4 Oct 2026 Payment Bob $10.00 $0.00 Alice $0.00 $10.00 $10.00')
  })

  it('prints a refund with negative amounts', async () => {
    const snapshot = buildStatementSnapshot({
      ...goldenInput([
        line(
          '2026-10-12',
          'expense',
          -2000,
          [share('alice', -2000, -1000), share('bob', 0, -1000)],
          { description: 'Refund: returned kettle' },
        ),
      ]),
      previousClosing: [],
    })
    const text = await pdfText(await renderDividePdf(snapshot))
    expect(text).toContain(
      '12 Oct 2026 Refund: returned kettle Alice -$20.00 -$10.00 Bob $0.00 -$10.00 -$20.00',
    )
    // Alice got the whole refund back, so she owes Bob his half.
    expect(text).toContain('Alice pays Bob $10.00')
  })

  it('leaves out the transactions table when there are no lines', async () => {
    const text = await pdfText(await renderDividePdf(buildStatementSnapshot(goldenInput([]))))
    expect(text).toContain('Bob -$3.00 $0.00 $0.00 -$3.00 owes $3.00')
    expect(text).toContain('Bob pays Erin $3.00')
    expect(text).not.toContain('Date Description')
  })

  it('wraps long words in names and descriptions, so no amount falls off the page', async () => {
    const input = goldenInput([
      line('2026-10-02', 'expense', 4000, [share('alice', 4000, 2000), share('bob', 0, 2000)], {
        description: `Order ${'X'.repeat(60)}`,
      }),
    ])
    input.people = input.people.map((person) =>
      person.personId === 'alice' ? { ...person, name: `Alice${'y'.repeat(60)}` } : person,
    )
    input.group = { ...input.group, name: `House${'Z'.repeat(80)}` }
    const pdf = await renderDividePdf(buildStatementSnapshot(input))
    expect(await textBeyondPage(pdf)).toEqual([])
    // pdfmake leaves out a cell that would start past the edge, so check the right-hand ones
    // are all there: the closings in words, and $40.00 as Alice's paid amount in both tables
    // and as the line's total.
    const text = await pdfText(pdf)
    expect(text).toContain('is owed $20.00')
    expect(text).toContain('owes $23.00')
    expect(text.match(/\$40\.00/g)).toHaveLength(3)
  })

  it('never splits a transaction across pages, and keeps the heading with its table', async () => {
    const people = Array.from({ length: 15 }, (_, index) => ({
      personId: `p${String(index).padStart(2, '0')}`,
      name: `Housemate ${index + 1}`,
    }))
    const lines = Array.from({ length: 40 }, (_, index) =>
      line(
        `2026-10-${String((index % 28) + 1).padStart(2, '0')}`,
        'expense',
        1500,
        people.map((person, at) => share(person.personId, at === index % 15 ? 1500 : 0, 100)),
        { description: `Shopping ${index + 1}` },
      ),
    )
    const pages = await pageTexts(
      await renderDividePdf(
        buildStatementSnapshot({ ...goldenInput(lines), people, previousClosing: [] }),
      ),
    )
    expect(pages.length).toBeGreaterThan(3)
    // Every page the table runs onto starts it again with its heading and a dated line.
    const runs = pages.filter((page) => page.includes('Date Description Paid Share Total'))
    expect(runs.length).toBeGreaterThan(2)
    for (const page of runs) {
      expect(page).toMatch(
        /Transactions Date Description Paid Share Total \d{1,2} Oct 2026 Shopping/,
      )
      // A line's people and total end on the page it starts on.
      const shopping = page.match(/Shopping \d+/g) ?? []
      expect(page.trimEnd()).toMatch(/\$15\.00 Divide .* · page \d+ of \d+$/)
      expect(shopping.length).toBeGreaterThan(0)
    }
  })

  it('renders 500 lines between 15 people, well under the 10 MB bucket limit', async () => {
    const people = Array.from({ length: 15 }, (_, index) => ({
      personId: `p${String(index).padStart(2, '0')}`,
      name: `Housemate ${index + 1}`,
    }))
    const lines = Array.from({ length: 500 }, (_, index) =>
      line(
        `2026-10-${String((index % 31) + 1).padStart(2, '0')}`,
        'expense',
        1500,
        people.map((person, at) => share(person.personId, at === index % 15 ? 1500 : 0, 100)),
        { description: `Shared shopping ${index + 1}` },
      ),
    )
    const pdf = await renderDividePdf(
      buildStatementSnapshot({ ...goldenInput(lines), people, previousClosing: [] }),
    )
    expect(pdf.length).toBeLessThan(10 * 1024 * 1024)
    expect(await pdfText(pdf)).toContain('Shared shopping 500')
  }, 60_000)

  it('refuses an invoice snapshot', async () => {
    const snapshot = buildStatementSnapshot(goldenInput())
    const employer = { ...snapshot, group: { ...snapshot.group, type: 'employer' as const } }
    await expect(renderDividePdf(employer)).rejects.toThrow('needs a house snapshot')
  })
})
