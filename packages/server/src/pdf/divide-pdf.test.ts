import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parseLocalDate } from '@ledgerly/core/dates/local-date'
import { fontRuns } from '@ledgerly/core/pdf/pdf-glyphs'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { buildStatementSnapshot, type SnapshotInput } from '@ledgerly/core/statements/snapshot'
import { extractText, getDocumentProxy } from 'unpdf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDividePdf, wrappedLines } from './divide-pdf'
import { useFontReader } from './fonts'

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
})

afterEach(() => {
  vi.restoreAllMocks()
})

// What logProblem wrote with console.warn, parsed.
const logged = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map(([line]) => JSON.parse(String(line)))

// Alice, Bob and Cara renamed; the golden divide otherwise.
function renamed(
  names: { alice: string; bob: string; cara: string },
  group = '12 Smith St',
  description = 'Electricity',
): SnapshotInput {
  const input = goldenInput([
    line(
      '2026-10-10',
      'bill',
      27000,
      [share('alice', 27000, 10139), share('bob', 0, 10139), share('cara', 0, 6722)],
      { description },
    ),
  ])
  return {
    ...input,
    group: { ...input.group, name: group },
    people: input.people.map((person) => ({
      ...person,
      name: names[person.personId as keyof typeof names] ?? person.name,
    })),
  }
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

  it('keeps a line too tall for one page, letting it break, with every other line', async () => {
    // pdfmake leaves out the rest of a row it may not break once it outgrows the page.
    const people = Array.from({ length: 15 }, (_, index) => ({
      personId: `p${String(index).padStart(2, '0')}`,
      name: `${String.fromCharCode(65 + index)}${'W'.repeat(99)}`,
    }))
    const lines = [
      line(
        '2026-10-03',
        'bill',
        150000,
        people.map((person, at) => share(person.personId, at === 0 ? 150000 : 0, 10000)),
        { description: 'W'.repeat(200) },
      ),
      line('2026-10-04', 'expense', 1500, [share('p00', 1500, 750), share('p01', 0, 750)], {
        description: 'Milk',
      }),
    ]
    const pdf = await renderDividePdf(
      buildStatementSnapshot({ ...goldenInput(lines), people, previousClosing: [] }),
    )
    const text = await pdfText(pdf)
    expect(text).toContain('Transactions Date Description Paid Share Total 3 Oct 2026')
    // The tall line's total, and the next line whole.
    expect(text).toMatch(/\$100\.00 \$1,500\.00 .*4 Oct 2026 Milk/)
    expect(text).toContain('Milk A')
    expect(await textBeyondPage(pdf)).toEqual([])
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

  it('prints Chinese, Japanese, Korean and emoji in their own fonts (#300)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = renamed(
      { alice: '张三', bob: 'ヤマダ ハナコ', cara: '김민준' },
      '12 Smith St 🏠',
      'Power 😀',
    )
    const text = await pdfText(await renderDividePdf(buildStatementSnapshot(input)))
    for (const expected of [
      '12 Smith St 🏠',
      '张三 $0.00 $270.00 $101.39 $168.61 is owed $168.61',
      'ヤマダ ハナコ -$3.00 $0.00 $101.39 -$104.39 owes $104.39',
      '김민준 $0.00 $0.00 $67.22 -$67.22 owes $67.22',
      'ヤマダ ハナコ pays 张三 $104.39',
      '김민준 pays Erin $3.00',
      '10 Oct 2026 Power 😀 张三 $270.00 $101.39 ヤマダ ハナコ $0.00 $101.39 김민준 $0.00 $67.22',
    ]) {
      expect(text).toContain(expected)
    }
    // Nothing printed as �, or left out (an unknown glyph extracts as U+0000).
    expect(text).not.toContain('\uFFFD')
    expect(text).not.toContain('\u0000')
    expect(warn).not.toHaveBeenCalled()
    expect(reads).toEqual(['NotoEmoji_400Regular.ttf', 'NotoSansCJKsc-Regular.otf'])
  })

  it('reads no font file for a divide Roboto can print', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderDividePdf(buildStatementSnapshot(goldenInput()))
    expect(reads).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  // Thai is in no font. The log line has the count only, never the text.
  it('prints a character no font has as \uFFFD in every text, and logs how many', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = renamed({ alice: 'Alice', bob: 'Bob', cara: 'ก Cara' }, 'ก House', 'ก bill')
    const text = await pdfText(await renderDividePdf(buildStatementSnapshot(input)))
    for (const expected of [
      '\uFFFD House',
      '\uFFFD Cara $0.00 $0.00 $67.22',
      '\uFFFD Cara pays Alice $64.22',
      '\uFFFD Cara pays Erin $3.00',
      '10 Oct 2026 \uFFFD bill Alice $270.00 $101.39 Bob $0.00 $101.39 \uFFFD Cara $0.00 $67.22',
    ]) {
      expect(text).toContain(expected)
    }
    expect(text).not.toContain('ก')
    expect(text).not.toContain('\u0000')
    // The house name, the description, and Cara in the people table, two transfers and the line.
    expect(logged(warn)).toEqual([{ fn: 'unknown', event: 'pdf_characters_replaced', count: 6 }])
    expect(reads).toEqual([])
  })

  // A row pdfmake keeps whole but can't place on a page loses the whole table, heading and all,
  // without an error (#300). Counting 10 characters a line, this one counted 45 of 45 lines (15
  // names of 20 characters, and a description of 140 with breakable()'s zero-width spaces), but
  // Noto Sans CJK's lines are about 24% taller than Roboto's. Every character is different, so
  // each one is checked wherever the names wrap between the amounts.
  it('prints a row of Chinese names and description whole, or across pages, never dropped', async () => {
    const chars = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => String.fromCodePoint(from + i)).join('')
    const names = Array.from({ length: 15 }, (_, i) => chars(0x4e00 + i * 20, 20))
    const description = chars(0x5000, 140)
    const input = goldenInput([
      line(
        '2026-10-10',
        'bill',
        15000,
        names.map((_, i) => share(`p${i}`, i === 0 ? 15000 : 0, 1000)),
        { description },
      ),
    ])
    const snapshot = buildStatementSnapshot({
      ...input,
      people: names.map((name, i) => ({ personId: `p${i}`, name })),
      previousClosing: [],
    })
    const text = (await pageTexts(await renderDividePdf(snapshot))).join(' ')
    // From the table's heading on, every character of the row, wherever its lines wrap.
    const heading = text.indexOf('Transactions Date Description')
    expect(heading).toBeGreaterThanOrEqual(0)
    const table = text.slice(heading)
    for (const char of names.join('') + description) expect(table).toContain(char)
  })

  // A divide of one line between `names`: its text from the transactions table's heading on.
  async function tableOf(description: string, names: string[]): Promise<string> {
    const input = goldenInput([
      line(
        '2026-10-10',
        'bill',
        1000 * names.length,
        names.map((_, i) => share(`p${i}`, i === 0 ? 1000 * names.length : 0, 1000)),
        { description },
      ),
    ])
    const snapshot = buildStatementSnapshot({
      ...input,
      people: names.map((name, i) => ({ personId: `p${i}`, name })),
      previousClosing: [],
    })
    const text = (await pageTexts(await renderDividePdf(snapshot))).join(' ')
    const heading = text.indexOf('Transactions Date Description')
    expect(heading).toBeGreaterThanOrEqual(0)
    return text.slice(heading)
  }
  const count = (text: string, char: string) => text.split(char).length - 1

  // U+FB2C is 1 character as typed and 3 as printed (NFC, then a � for each part no font has):
  // the row is counted as printed, so it breaks across pages rather than vanish.
  it('counts a row as printed, so characters that print as several � are never dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const table = await tableOf(Array(50).fill('\uFB2C'.repeat(3)).join(' '), ['A', 'B'])
    expect(count(table, '\uFFFD')).toBe(450)
    expect(logged(warn)).toEqual([{ fn: 'unknown', event: 'pdf_characters_replaced', count: 450 }])
  })

  // ⏩ is 1 unit, 1.27 em wide in Noto Emoji, and pdfmake can't break between two of them, so two
  // words of 7 don't fit on one line.
  it('never drops a row of emoji words that leave each line part empty', async () => {
    const name = Array(12).fill('⏩'.repeat(7)).join(' ')
    const table = await tableOf(Array(4).fill('⏩'.repeat(8)).join(' '), Array(4).fill(name))
    expect(count(table, '⏩')).toBe(4 * 84 + 32)
  })

  // pdfmake starts a new line at each line feed: a description stored with them (#346) still
  // counts each one as a line.
  it('never drops a row whose description has line feeds', async () => {
    const table = await tableOf(Array(100).fill('x').join('\n'), ['A', 'B'])
    expect(count(table, 'x')).toBe(100)
  })

  it('refuses an invoice snapshot', async () => {
    const snapshot = buildStatementSnapshot(goldenInput())
    const employer = { ...snapshot, group: { ...snapshot.group, type: 'employer' as const } }
    await expect(renderDividePdf(employer)).rejects.toThrow('needs a house snapshot')
  })
})

describe('wrappedLines', () => {
  const lines = (text: string) => wrappedLines(fontRuns(text))

  it.each([
    ['nothing', '', 1],
    ['a word', 'Electricity', 1],
    // Roboto's widest is 11.79 pt, in a 171 pt cell.
    ['14 of the widest', 'W'.repeat(14), 1],
    ['15 of the widest, wrapped', 'W'.repeat(15), 2],
    // Each word and its space is 94.3 pt, so two don't fit.
    ['three words that fit one a line', 'abcdefg abcdefg abcdefg', 3],
    ['a line feed', 'a\nb', 2],
    // Noto Emoji's characters are 12.7 pt: 13 fit.
    ['13 emoji', '😀'.repeat(13), 1],
    ['14 emoji', '😀'.repeat(14), 2],
    // As printed: ร้าน is 4 �.
    ['Thai', 'ร้าน', 1],
    // A line with Noto Sans CJK is 1.25 of Roboto's.
    ['Chinese', '张三', 1.25],
    ['Chinese with Latin', '张三 Pty Ltd', 1.25],
  ])('counts %s', (_, text, expected) => {
    expect(lines(text)).toBe(expected)
  })

  it('counts each Noto Sans CJK character as wide as its widest, ⸻', () => {
    // 7 of 24.59 pt fill 172 pt, more than the cell.
    expect(lines('一'.repeat(6))).toBe(1.25)
    expect(lines('一'.repeat(7))).toBe(2.5)
  })
})
