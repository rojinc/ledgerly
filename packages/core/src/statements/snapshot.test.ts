import { describe, expect, it } from 'vitest'
import { parseLocalDate } from '../dates/local-date'
import { LedgerError } from '../ledger/ledger-error'
import { type StatementSnapshot, statementSnapshotSchema } from '../schemas/statements'
import { buildStatementSnapshot, checkSnapshot, type SnapshotInput } from './snapshot'

const d = parseLocalDate
type Line = StatementSnapshot['lines'][number]

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
  description: kind,
  totalCents,
  shares,
  ...extra,
})
const share = (personId: string, givenCents: number, receivedCents: number) => ({
  personId,
  givenCents,
  receivedCents,
})

const business = { businessName: 'Sam Lee Services', email: 'sam@example.com' }
const employerInput = (lines: Line[], previousClosing: SnapshotInput['previousClosing']) => ({
  group: {
    id: 'grp_employer',
    name: 'Acme',
    type: 'employer' as const,
    currency: 'AUD',
    timezone: 'Australia/Sydney',
  },
  period: { start: d('2026-10-01'), end: d('2026-10-31') },
  people: [
    { personId: 'worker', name: 'Sam' },
    { personId: 'employer', name: 'Acme' },
  ],
  previousClosing,
  lines,
  issuer: { personId: 'worker', name: 'Sam', business },
  recipient: { personId: 'employer', name: 'Acme', emails: ['accounts@example.com'] },
  paymentTermsDays: 14,
  generatedAt: '2026-11-01T00:00:00.000Z',
})

describe('buildStatementSnapshot', () => {
  it('golden: an employer invoice with opening 50000 comes to a balance due of 71500', () => {
    const shift = (date: string, cents: number) =>
      line(date, 'shift', cents, [share('worker', cents, 0), share('employer', 0, cents)], {
        shift: { minutes: (cents / 2500) * 60, rateCents: 2500 },
      })
    const lines = [
      shift('2026-10-29', 17500),
      shift('2026-10-01', 12500),
      shift('2026-10-08', 12500),
      shift('2026-10-15', 12500),
      shift('2026-10-22', 12500),
      // Reimbursable: the worker paid for the employer.
      line('2026-10-10', 'expense', 4000, [share('worker', 4000, 0), share('employer', 0, 4000)]),
      // Payment received from the employer.
      line('2026-10-20', 'payment', 50000, [
        share('employer', 50000, 0),
        share('worker', 0, 50000),
      ]),
      // Bought on the employer's card for work: net 0.
      line('2026-10-12', 'expense', 12000, [share('employer', 12000, 12000)]),
    ]
    const snapshot = buildStatementSnapshot(
      employerInput(lines, [
        { personId: 'worker', netCents: 50000 },
        { personId: 'employer', netCents: -50000 },
      ]),
    )

    expect(snapshot.people).toEqual([
      {
        personId: 'employer',
        name: 'Acme',
        openingCents: -50000,
        givenCents: 62000,
        receivedCents: 83500,
        closingCents: -71500,
      },
      {
        personId: 'worker',
        name: 'Sam',
        openingCents: 50000,
        givenCents: 71500,
        receivedCents: 50000,
        closingCents: 71500,
      },
    ])
    expect(snapshot.invoice).toEqual({ balanceDueCents: 71500, paymentTermsDays: 14 })
    expect(snapshot.transfers).toEqual([])
    expect(snapshot.lines.map((l) => l.date)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-10',
      '2026-10-12',
      '2026-10-15',
      '2026-10-20',
      '2026-10-22',
      '2026-10-29',
    ])
    expect(statementSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(
      checkSnapshot(snapshot, [
        { personId: 'worker', netCents: 71500 },
        { personId: 'employer', netCents: -71500 },
      ]),
    ).toEqual([])
  })

  it('a house divide carries openings forward and suggests transfers', () => {
    // User flow 6: electricity $270, Alice paid, split by days present.
    const lines = [
      line('2026-10-10', 'bill', 27000, [
        share('alice', 27000, 10139),
        share('bob', 0, 10139),
        share('cara', 0, 6722),
      ]),
    ]
    const snapshot = buildStatementSnapshot({
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
      // Dan is square and had nothing this month, so he's left out; Erin
      // moved out still owed $3, so she stays.
      previousClosing: [
        { personId: 'bob', netCents: -300 },
        { personId: 'dan', netCents: 0 },
        { personId: 'erin', netCents: 300 },
      ],
      lines,
      generatedAt: '2026-11-01T00:00:00.000Z',
    })

    expect(snapshot.people.map((p) => [p.personId, p.openingCents, p.closingCents])).toEqual([
      ['alice', 0, 16861],
      ['bob', -300, -10439],
      ['cara', 0, -6722],
      ['erin', 300, 300],
    ])
    expect(snapshot.transfers).toEqual([
      { fromPersonId: 'bob', toPersonId: 'alice', cents: 10439 },
      { fromPersonId: 'cara', toPersonId: 'alice', cents: 6422 },
      { fromPersonId: 'cara', toPersonId: 'erin', cents: 300 },
    ])
    expect(snapshot).not.toHaveProperty('invoice')
    expect(snapshot).not.toHaveProperty('issuer')
    expect(snapshot).not.toHaveProperty('recipient')
    expect(statementSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    // Erin has an opening but no lines; her closing still checks out.
    const fresh = snapshot.people.map((p) => ({ personId: p.personId, netCents: p.closingCents }))
    expect(checkSnapshot(snapshot, fresh)).toEqual([])
  })

  it('orders lines by date, then transaction ID', () => {
    const pay = () =>
      line('2026-10-05', 'payment', 100, [share('employer', 100, 0), share('worker', 0, 100)])
    const [first, second] = [pay(), pay()]
    const later = line('2026-10-06', 'payment', 100, [
      share('employer', 100, 0),
      share('worker', 0, 100),
    ])
    const snapshot = buildStatementSnapshot(employerInput([later, second, first], []))
    expect(snapshot.lines).toEqual([first, second, later])
  })

  it('an invoice with nothing in it is due 0', () => {
    const snapshot = buildStatementSnapshot(employerInput([], []))
    expect(snapshot.people).toEqual([])
    expect(snapshot.invoice).toEqual({ balanceDueCents: 0, paymentTermsDays: 14 })
  })

  it('throws for a non-member, or an invoice without issuer, recipient or terms', () => {
    const stranger = [
      line('2026-10-02', 'payment', 100, [share('zoe', 100, 0), share('worker', 0, 100)]),
    ]
    expect(() => buildStatementSnapshot(employerInput(stranger, []))).toThrow('member')
    expect(() => buildStatementSnapshot({ ...employerInput([], []), issuer: undefined })).toThrow(
      'issuer',
    )
    expect(() =>
      buildStatementSnapshot({ ...employerInput([], []), paymentTermsDays: undefined }),
    ).toThrow('payment terms')
    expect(() =>
      buildStatementSnapshot({ ...employerInput([], []), recipient: undefined }),
    ).toThrow('recipient')
    // A user ID passed as the issuer's person ID must not make a $0 invoice.
    const shift = [
      line('2026-10-02', 'shift', 12500, [share('worker', 12500, 0), share('employer', 0, 12500)]),
    ]
    const wrongIssuer = { personId: 'usr_owner', name: 'Sam', business }
    let caught: unknown
    try {
      buildStatementSnapshot({ ...employerInput(shift, []), issuer: wrongIssuer })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LedgerError)
    expect((caught as LedgerError).code).toBe('INVARIANT_VIOLATION')
    expect((caught as LedgerError).message).toMatch('issuer must be a member')
    const toSelf = { personId: 'worker', name: 'Sam', emails: ['sam@example.com'] }
    expect(() =>
      buildStatementSnapshot({ ...employerInput(shift, []), recipient: toSelf }),
    ).toThrow('bill themselves')
  })

  it('suggests no transfers for a divide whose closings don’t add up, so the check catches it', () => {
    const snapshot = buildStatementSnapshot({
      group: {
        id: 'grp_house',
        name: '12 Smith St',
        type: 'house',
        currency: 'AUD',
        timezone: 'Australia/Sydney',
      },
      period: { start: d('2026-10-01'), end: d('2026-10-31') },
      people: [{ personId: 'alice', name: 'Alice' }],
      previousClosing: [{ personId: 'alice', netCents: 100 }],
      lines: [],
      generatedAt: '2026-11-01T00:00:00.000Z',
    })
    expect(snapshot.transfers).toEqual([])
    expect(checkSnapshot(snapshot, [{ personId: 'alice', netCents: 100 }])).toEqual(['balanced'])
  })
})

describe('checkSnapshot', () => {
  const lines = [
    line('2026-10-02', 'shift', 12500, [share('worker', 12500, 0), share('employer', 0, 12500)]),
  ]
  const snapshot = buildStatementSnapshot(
    employerInput(lines, [
      { personId: 'worker', netCents: 1000 },
      { personId: 'employer', netCents: -1000 },
    ]),
  )
  const fresh = [
    { personId: 'worker', netCents: 13500 },
    { personId: 'employer', netCents: -13500 },
  ]
  const withPeople = (people: StatementSnapshot['people']) => ({ ...snapshot, people })
  const [employer, worker] = snapshot.people as [
    StatementSnapshot['people'][number],
    StatementSnapshot['people'][number],
  ]

  it('passes a correct snapshot', () => {
    expect(checkSnapshot(snapshot, fresh)).toEqual([])
  })

  it('finds closings that don’t match the stored shares', () => {
    expect(checkSnapshot(snapshot, [{ personId: 'worker', netCents: 13500 }])).toEqual(['fresh'])
    expect(checkSnapshot(snapshot, [...fresh, { personId: 'ghost', netCents: 0 }])).toEqual([])
    expect(checkSnapshot(snapshot, [...fresh, { personId: 'ghost', netCents: 5 }])).toEqual([
      'fresh',
    ])
  })

  it('finds a closing that isn’t opening + nets', () => {
    // Swapped closings still add up to 0, but neither matches its lines.
    const swapped = withPeople([
      { ...employer, closingCents: worker.closingCents },
      { ...worker, closingCents: employer.closingCents },
    ])
    expect(checkSnapshot(swapped, fresh)).toEqual(['closing', 'fresh'])
  })

  it('finds a line share for someone not listed', () => {
    expect(checkSnapshot(withPeople([worker]), fresh)).toEqual(['closing', 'balanced', 'fresh'])
  })

  it('finds closings that don’t add up to 0', () => {
    const lopsided = withPeople([
      employer,
      { ...worker, openingCents: worker.openingCents + 1, closingCents: worker.closingCents + 1 },
    ])
    expect(checkSnapshot(lopsided, fresh)).toEqual(['balanced', 'fresh'])
  })
})
