import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { businessDetailsSchema } from './identity'
import {
  closeStatementBodySchema,
  finalizeStatementBodySchema,
  previewStatementBodySchema,
  reissueStatementBodySchema,
  snapshotBusinessSchema,
  statementSnapshotSchema,
  voidStatementBodySchema,
} from './statements'

const paths = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? []

const invoice = {
  version: 1,
  group: {
    id: 'acme',
    name: 'Acme Pty Ltd',
    type: 'employer',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
  },
  period: { start: '2026-10-01', end: '2026-10-31' },
  issuer: { personId: 'sam', name: 'Sam Lee', business: { businessName: 'Sam Lee Cleaning' } },
  recipient: { personId: 'acme-person', name: 'Acme', emails: ['accounts@example.com'] },
  people: [
    {
      personId: 'sam',
      name: 'Sam Lee',
      openingCents: 10_000,
      givenCents: 12_500,
      receivedCents: 0,
      closingCents: 22_500,
    },
    {
      personId: 'acme-person',
      name: 'Acme',
      openingCents: -10_000,
      givenCents: 0,
      receivedCents: 12_500,
      closingCents: -22_500,
    },
  ],
  lines: [
    {
      transactionId: 'tx1',
      date: '2026-10-29',
      kind: 'shift',
      description: 'Thursday shift',
      category: 'work',
      totalCents: 12_500,
      shift: { minutes: 300, rateCents: 2500 },
      shares: [
        { personId: 'sam', givenCents: 12_500, receivedCents: 0 },
        { personId: 'acme-person', givenCents: 0, receivedCents: 12_500 },
      ],
    },
  ],
  transfers: [],
  invoice: { balanceDueCents: 22_500, paymentTermsDays: 14, dueOn: '2026-11-15' },
  generatedAt: '2026-11-01T19:00:00.000Z',
} satisfies z.input<typeof statementSnapshotSchema>

const divide = {
  ...invoice,
  group: { ...invoice.group, type: 'house' },
  issuer: undefined,
  recipient: undefined,
  invoice: undefined,
  transfers: [{ fromPersonId: 'acme-person', toPersonId: 'sam', cents: 22_500 }],
} satisfies z.input<typeof statementSnapshotSchema>

describe('statementSnapshotSchema', () => {
  it('accepts an invoice and a divide', () => {
    expect(statementSnapshotSchema.parse(invoice)).toEqual(invoice)
    expect(paths(statementSnapshotSchema, divide)).toEqual([])
  })

  it('rejects another version, group type or a missing part', () => {
    expect(paths(statementSnapshotSchema, { ...invoice, version: 2 })).toEqual(['version'])
    expect(
      paths(statementSnapshotSchema, { ...invoice, group: { ...invoice.group, type: 'pair' } }),
    ).toEqual(['group.type'])
    expect(paths(statementSnapshotSchema, { ...invoice, people: undefined })).toEqual(['people'])
  })

  it('allows balances past MAX_AMOUNT_CENTS but not line amounts', () => {
    const [sam, acme] = invoice.people
    const big = 20_000_000_000
    expect(
      paths(statementSnapshotSchema, {
        ...invoice,
        people: [
          { ...sam, closingCents: big },
          { ...acme, closingCents: -big },
        ],
      }),
    ).toEqual([])
    const [line] = invoice.lines
    expect(
      paths(statementSnapshotSchema, { ...invoice, lines: [{ ...line, totalCents: big }] }),
    ).toEqual(['lines.0.totalCents'])
  })

  it('keeps kind and category as plain text, so old snapshots always parse', () => {
    const [line] = invoice.lines
    const old = { ...line, kind: 'retired-kind', category: 'retired-category' }
    expect(paths(statementSnapshotSchema, { ...invoice, lines: [old] })).toEqual([])
    expect(paths(statementSnapshotSchema, { ...invoice, lines: [{ ...line, kind: 3 }] })).toEqual([
      'lines.0.kind',
    ])
  })

  it('keeps business details as plain text, so old snapshots always parse (#543)', () => {
    // An ABN today's Profile rules refuse, as a later, stricter rule would leave stored ones.
    const business = { businessName: 'Sam Lee Cleaning', abn: '1', email: 'not an email' }
    const old = { ...invoice, issuer: { ...invoice.issuer, business } }
    expect(statementSnapshotSchema.parse(old).issuer?.business).toEqual(business)
    expect(businessDetailsSchema.safeParse(business).success).toBe(false)
  })

  it('takes a whole bank or none, and only the Profile’s fields', () => {
    const withBank = (bank: object) => ({
      ...invoice,
      issuer: { ...invoice.issuer, business: { bank } },
    })
    const bank = { accountName: 'Sam Lee', bsb: '062000', accountNumber: '12345678' }
    expect(paths(statementSnapshotSchema, withBank(bank))).toEqual([])
    expect(paths(statementSnapshotSchema, withBank({ bsb: '062000' }))).toEqual([
      'issuer.business.bank.accountName',
      'issuer.business.bank.accountNumber',
    ])
    expect(
      paths(statementSnapshotSchema, {
        ...invoice,
        issuer: { ...invoice.issuer, business: { notes: 'x' } },
      }),
    ).toEqual(['issuer.business'])
    expect(
      paths(statementSnapshotSchema, {
        ...invoice,
        issuer: { ...invoice.issuer, business: { abn: 51824753556 } },
      }),
    ).toEqual(['issuer.business.abn'])
  })

  it('has the Profile’s business fields, and the bank’s', () => {
    const keys = (schema: { shape: object }) => Object.keys(schema.shape).sort()
    expect(keys(snapshotBusinessSchema)).toEqual(keys(businessDetailsSchema))
    expect(keys(snapshotBusinessSchema.shape.bank.unwrap())).toEqual(
      keys(businessDetailsSchema.shape.bank.unwrap()),
    )
  })

  it('rejects transfers of zero and instants that are not UTC', () => {
    expect(
      paths(statementSnapshotSchema, {
        ...divide,
        transfers: [{ fromPersonId: 'acme-person', toPersonId: 'sam', cents: 0 }],
      }),
    ).toEqual(['transfers.0.cents'])
    expect(
      paths(statementSnapshotSchema, { ...invoice, generatedAt: '2026-11-02T06:00:00+11:00' }),
    ).toEqual(['generatedAt'])
  })
})

describe('previewStatementBodySchema', () => {
  it('needs a group', () => {
    expect(paths(previewStatementBodySchema, { groupId: 'acme' })).toEqual([])
    expect(paths(previewStatementBodySchema, { groupId: 'acme', periodEnd: '2026-10-31' })).toEqual(
      [],
    )
    expect(paths(previewStatementBodySchema, { periodEnd: '2026-10-31' })).toEqual(['groupId'])
  })
})

describe('closeStatementBodySchema', () => {
  it('needs a group, and takes an optional real end date and nothing else', () => {
    expect(paths(closeStatementBodySchema, { groupId: 'acme' })).toEqual([])
    expect(paths(closeStatementBodySchema, { groupId: 'acme', periodEnd: '2026-10-20' })).toEqual(
      [],
    )
    expect(paths(closeStatementBodySchema, { periodEnd: '2026-10-20' })).toEqual(['groupId'])
    expect(paths(closeStatementBodySchema, { groupId: 'acme', periodEnd: '2026-02-30' })).toEqual([
      'periodEnd',
    ])
    expect(paths(closeStatementBodySchema, { groupId: 'acme', periodStart: '2026-10-01' })).toEqual(
      [''],
    )
  })
})

describe('finalizeStatementBodySchema', () => {
  it('needs send', () => {
    expect(paths(finalizeStatementBodySchema, { send: true })).toEqual([])
    expect(paths(finalizeStatementBodySchema, {})).toEqual(['send'])
  })
})

describe('voidStatementBodySchema', () => {
  it('needs a reason', () => {
    expect(paths(voidStatementBodySchema, { reason: 'Wrong rate' })).toEqual([])
    expect(paths(voidStatementBodySchema, { reason: '' })).toEqual(['reason'])
  })
})

describe('reissueStatementBodySchema', () => {
  const body = { groupId: 'acme', periodStart: '2026-10-01', periodEnd: '2026-10-31' }

  it('needs a period that ends on or after it starts', () => {
    expect(paths(reissueStatementBodySchema, body)).toEqual([])
    expect(paths(reissueStatementBodySchema, { ...body, periodEnd: '2026-09-30' })).toEqual([
      'periodEnd',
    ])
    expect(paths(reissueStatementBodySchema, { ...body, periodStart: undefined })).toEqual([
      'periodStart',
    ])
  })
})
