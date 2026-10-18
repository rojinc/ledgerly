import { describe, expect, it } from 'vitest'
import { CATEGORIES } from '../constants/categories'
import { TRANSACTION_KINDS } from '../constants/domain'
import {
  buildPersonalReport,
  type ReportGroup,
  type ReportShare,
  reportByMonth,
} from './personal-report'

const groups: ReportGroup[] = [
  { id: 'house', type: 'house', currency: 'AUD' },
  { id: 'acme', type: 'employer', currency: 'AUD' },
  { id: 'sam', type: 'pair', currency: 'AUD' },
  { id: 'mine', type: 'personal', currency: 'AUD' },
]

const share = (part: Partial<ReportShare> & Pick<ReportShare, 'groupId' | 'kind'>) => ({
  personId: 'me',
  date: '2026-10-15',
  category: null,
  givenCents: 0,
  receivedCents: 0,
  ...part,
})

// ledger.md#worked-examples, with "me" as Alice in the house, the worker at Acme
// and the lender to Sam, plus $1,000 of personal income.
const worked: ReportShare[] = [
  share({
    groupId: 'house',
    kind: 'bill',
    category: 'electricity',
    givenCents: 9000,
    receivedCents: 3000,
  }),
  share({
    groupId: 'house',
    kind: 'bill',
    category: 'electricity',
    personId: 'bob',
    receivedCents: 3000,
  }),
  share({
    groupId: 'house',
    kind: 'bill',
    category: 'electricity',
    personId: 'cara',
    receivedCents: 3000,
  }),
  share({ groupId: 'house', kind: 'payment', personId: 'bob', givenCents: 3000 }),
  share({ groupId: 'house', kind: 'payment', receivedCents: 3000 }),
  share({ groupId: 'acme', kind: 'shift', category: 'work', givenCents: 12_500 }),
  share({
    groupId: 'acme',
    kind: 'shift',
    category: 'work',
    personId: 'acme',
    receivedCents: 12_500,
  }),
  share({ groupId: 'acme', kind: 'payment', personId: 'acme', givenCents: 50_000 }),
  share({ groupId: 'acme', kind: 'payment', receivedCents: 50_000 }),
  share({
    groupId: 'acme',
    kind: 'expense',
    category: 'work',
    personId: 'acme',
    givenCents: 12_000,
    receivedCents: 12_000,
  }),
  share({ groupId: 'sam', kind: 'loan', givenCents: 5000 }),
  share({ groupId: 'sam', kind: 'loan', personId: 'sam', receivedCents: 5000 }),
  share({
    groupId: 'house',
    kind: 'expense',
    category: 'groceries',
    givenCents: -2000,
    receivedCents: -1000,
  }),
  share({
    groupId: 'house',
    kind: 'expense',
    category: 'groceries',
    personId: 'bob',
    receivedCents: -1000,
  }),
  share({ groupId: 'mine', kind: 'income', givenCents: 100_000, receivedCents: 100_000 }),
]

describe('buildPersonalReport', () => {
  it('sums the worked examples with the formulas in ledger.md#reports', () => {
    expect(buildPersonalReport('me', worked, groups)).toEqual([
      {
        currency: 'AUD',
        spendingCents: 2000, // electricity 3000, less the 1000 refund
        spendingByCategory: { electricity: 3000, groceries: -1000 },
        earningsCents: 12_500,
        moneyReceivedCents: 53_000, // Bob's 3000 and Acme's 50,000
        incomeCents: 150_000, // Acme's payment and personal income
        paidOutCents: 12_000, // 9000 bill + 5000 loan − 2000 refund
        personalIncomeCents: 100_000,
      },
    ])
  })

  it("gives the employer's view of the same shares", () => {
    expect(buildPersonalReport('acme', worked, groups)).toEqual([
      {
        currency: 'AUD',
        spendingCents: 12_000,
        spendingByCategory: { work: 12_000 },
        earningsCents: 0,
        moneyReceivedCents: 0,
        incomeCents: 0,
        paidOutCents: 62_000, // the card purchase and the 50,000 payment
        personalIncomeCents: 0,
      },
    ])
  })

  it('puts spending with no category under none, never other', () => {
    const shares = [
      share({ groupId: 'house', kind: 'expense', receivedCents: 400 }),
      share({ groupId: 'house', kind: 'expense', category: '', receivedCents: 100 }),
      share({ groupId: 'house', kind: 'expense', category: undefined, receivedCents: 50 }),
      share({ groupId: 'house', kind: 'expense', category: 'other', receivedCents: 25 }),
    ]
    const [report] = buildPersonalReport('me', shares, groups)
    expect(report?.spendingByCategory).toEqual({ none: 550, other: 25 })
  })

  it('counts payments as income only in employer groups, and income only in the personal group', () => {
    const shares = [
      share({ groupId: 'sam', kind: 'payment', receivedCents: 700 }),
      share({ groupId: 'house', kind: 'income', receivedCents: 900, givenCents: 900 }),
    ]
    const [report] = buildPersonalReport('me', shares, groups)
    expect(report).toMatchObject({
      moneyReceivedCents: 700,
      incomeCents: 0,
      personalIncomeCents: 0,
    })
  })

  it('keeps each currency separate, sorted by currency', () => {
    const many: ReportGroup[] = [
      { id: 'nz', type: 'house', currency: 'NZD' },
      { id: 'au', type: 'house', currency: 'AUD' },
      { id: 'jp', type: 'house', currency: 'JPY' },
    ]
    const shares = ['nz', 'au', 'jp', 'au'].map((groupId) =>
      share({ groupId, kind: 'expense', receivedCents: 100 }),
    )
    const reports = buildPersonalReport('me', shares, many)
    expect(reports.map((report) => [report.currency, report.spendingCents])).toEqual([
      ['AUD', 200],
      ['JPY', 100],
      ['NZD', 100],
    ])
  })

  it("ignores other people's shares, even in groups it wasn't given", () => {
    const shares = [
      share({ groupId: 'elsewhere', kind: 'expense', personId: 'bob', receivedCents: 1 }),
    ]
    expect(buildPersonalReport('me', shares, groups)).toEqual([])
  })

  it('throws for a share whose group is missing, rather than hide money', () => {
    const shares = [share({ groupId: 'elsewhere', kind: 'expense', receivedCents: 1 })]
    expect(() => buildPersonalReport('me', shares, groups)).toThrow(
      new RangeError("A share's group is missing from groups"),
    )
  })

  it('always has categories that add up to the spending', () => {
    const currencies: ReportGroup[] = [
      { id: 'a', type: 'house', currency: 'AUD' },
      { id: 'b', type: 'pair', currency: 'NZD' },
      { id: 'c', type: 'employer', currency: 'AUD' },
    ]
    const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T
    const cents = () => Math.floor(Math.random() * 2_000_000) - 1_000_000
    for (let run = 0; run < 200; run++) {
      const shares = Array.from({ length: 1 + Math.floor(Math.random() * 40) }, () =>
        share({
          personId: pick(['me', 'me', 'bob']),
          groupId: pick(currencies).id,
          kind: pick(TRANSACTION_KINDS),
          category: pick([...CATEGORIES, null, undefined]),
          givenCents: cents(),
          receivedCents: cents(),
        }),
      )
      for (const report of buildPersonalReport('me', shares, currencies)) {
        const byCategory = Object.values(report.spendingByCategory).reduce((a, b) => a + b, 0)
        expect(byCategory).toBe(report.spendingCents)
      }
    }
  })
})

describe('reportByMonth', () => {
  it('buckets by the YYYY-MM of the local date text, oldest first', () => {
    const shares = [
      share({ groupId: 'house', kind: 'expense', date: '2026-11-01', receivedCents: 300 }),
      share({ groupId: 'house', kind: 'expense', date: '2026-09-30', receivedCents: 100 }),
      share({ groupId: 'house', kind: 'expense', date: '2026-10-31', receivedCents: 200 }),
      share({ groupId: 'house', kind: 'expense', date: '2026-10-01', receivedCents: 50 }),
    ]
    const months = reportByMonth('me', shares, groups)
    expect(months.map(({ month, reports }) => [month, reports[0]?.spendingCents])).toEqual([
      ['2026-09', 100],
      ['2026-10', 250],
      ['2026-11', 300],
    ])
  })

  it('leaves out months with only other people’s shares', () => {
    const shares = [
      share({ groupId: 'house', kind: 'expense', date: '2026-10-05', receivedCents: 1 }),
      share({
        groupId: 'house',
        kind: 'expense',
        date: '2026-12-05',
        personId: 'bob',
        receivedCents: 1,
      }),
    ]
    expect(reportByMonth('me', shares, groups).map(({ month }) => month)).toEqual(['2026-10'])
  })
})
