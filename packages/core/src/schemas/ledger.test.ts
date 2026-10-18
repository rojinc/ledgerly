import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import {
  itemInputSchema,
  postTransactionBodySchema,
  startTimerBodySchema,
  stopTimerBodySchema,
  transactionInputSchema,
  transactionTemplateSchema,
  voidTransactionBodySchema,
} from './ledger'

const paths = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? []

const base = { id: 'tx1', groupId: 'house1', date: '2026-10-29', description: 'Electricity' }

const expense = {
  ...base,
  kind: 'expense',
  category: 'electricity',
  totalCents: 9000,
  payers: [{ personId: 'alice', cents: 9000 }],
  split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
  receiptFileIds: ['file1'],
  note: 'Q3',
} satisfies z.input<typeof transactionInputSchema>

const itemised = {
  ...base,
  kind: 'expense',
  description: 'Groceries',
  items: [
    {
      name: 'Milk',
      quantity: 2,
      amountCents: 450,
      category: 'groceries',
      split: { mode: 'equal', personIds: ['alice', 'bob'] },
    },
    {
      name: 'Discount',
      amountCents: -100,
      split: { mode: 'exact', amounts: [{ personId: 'alice', cents: -100 }] },
    },
  ],
} satisfies z.input<typeof transactionInputSchema>

const shift = {
  ...base,
  groupId: 'acme',
  kind: 'shift',
  description: 'Thursday shift',
  shift: { minutes: 300, rateCents: 2500, breakMinutes: 30, startTime: '09:00', endTime: '14:30' },
} satisfies z.input<typeof transactionInputSchema>

const bill = {
  ...base,
  kind: 'bill',
  totalCents: 9000,
  bill: { status: 'due', dueOn: '2026-11-14', periodStart: '2026-07-01', periodEnd: '2026-09-30' },
  split: { mode: 'days' },
} satisfies z.input<typeof transactionInputSchema>

const payment = {
  ...base,
  kind: 'payment',
  description: 'Settle up',
  totalCents: 3000,
  payment: { fromPersonId: 'bob', toPersonId: 'alice' },
} satisfies z.input<typeof transactionInputSchema>

const loan = {
  ...base,
  kind: 'loan',
  description: 'Lend Sam',
  totalCents: 5000,
  split: { mode: 'equal', personIds: ['sam'] },
} satisfies z.input<typeof transactionInputSchema>

const income = {
  ...base,
  kind: 'income',
  description: 'Salary',
  totalCents: 100_000,
} satisfies z.input<typeof transactionInputSchema>

const adjustment = {
  ...base,
  kind: 'adjustment',
  description: 'Correction',
  totalCents: 500,
  adjustment: {
    shares: [
      { personId: 'alice', givenCents: 500, receivedCents: 0 },
      { personId: 'bob', givenCents: 0, receivedCents: 500 },
    ],
    reason: 'October bill was entered twice',
  },
} satisfies z.input<typeof transactionInputSchema>

const refund = {
  ...expense,
  totalCents: -2000,
  payers: [{ personId: 'alice', cents: -2000 }],
} satisfies z.input<typeof transactionInputSchema>

describe('transactionInputSchema', () => {
  it.each([
    ['expense', expense],
    ['itemised expense', itemised],
    ['shift', shift],
    ['bill', bill],
    ['payment', payment],
    ['loan', loan],
    ['income', income],
    ['adjustment', adjustment],
    ['refund', refund],
  ])('accepts a %s', (_, input) => {
    expect(transactionInputSchema.parse(input)).toEqual(input)
  })

  it('trims the description and requires 1–200 characters', () => {
    expect(transactionInputSchema.parse({ ...expense, description: ' Power ' }).description).toBe(
      'Power',
    )
    expect(paths(transactionInputSchema, { ...expense, description: '  ' })).toEqual([
      'description',
    ])
    expect(paths(transactionInputSchema, { ...expense, description: 'x'.repeat(201) })).toEqual([
      'description',
    ])
  })

  it('rejects unknown keys, kinds, dates and categories', () => {
    expect(paths(transactionInputSchema, { ...expense, status: 'posted' })).toEqual([''])
    expect(paths(transactionInputSchema, { ...expense, kind: 'gift' })).toEqual(['kind'])
    expect(paths(transactionInputSchema, { ...expense, date: '2026-02-30' })).toEqual(['date'])
    expect(paths(transactionInputSchema, { ...expense, category: 'pets' })).toEqual(['category'])
  })

  it('rejects amounts past MAX_AMOUNT_CENTS or with fractions of a cent', () => {
    expect(paths(transactionInputSchema, { ...expense, totalCents: MAX_AMOUNT_CENTS + 1 })).toEqual(
      ['totalCents'],
    )
    expect(paths(transactionInputSchema, { ...expense, totalCents: 90.5 })).toEqual(['totalCents'])
  })

  it('requires the part named after the kind', () => {
    expect(paths(transactionInputSchema, { ...shift, shift: undefined })).toEqual(['shift'])
    expect(paths(transactionInputSchema, { ...bill, bill: undefined })).toEqual(['bill'])
    expect(paths(transactionInputSchema, { ...payment, payment: undefined })).toEqual(['payment'])
    expect(paths(transactionInputSchema, { ...adjustment, adjustment: undefined })).toEqual([
      'adjustment',
    ])
    expect(() => transactionInputSchema.parse({ ...shift, shift: undefined })).toThrow(
      'Required for a shift',
    )
  })

  it('rejects parts that belong to another kind', () => {
    expect(paths(transactionInputSchema, { ...expense, shift: shift.shift })).toEqual(['shift'])
    expect(paths(transactionInputSchema, { ...expense, bill: bill.bill })).toEqual(['bill'])
    expect(paths(transactionInputSchema, { ...expense, payment: payment.payment })).toEqual([
      'payment',
    ])
    expect(paths(transactionInputSchema, { ...income, adjustment: adjustment.adjustment })).toEqual(
      ['adjustment'],
    )
    expect(paths(transactionInputSchema, { ...payment, split: loan.split })).toEqual(['split'])
    expect(paths(transactionInputSchema, { ...loan, items: itemised.items })).toEqual(['items'])
    const payers = [{ personId: 'alice', cents: 500 }]
    expect(paths(transactionInputSchema, { ...shift, payers })).toEqual(['payers'])
    expect(paths(transactionInputSchema, { ...payment, payers })).toEqual(['payers'])
    expect(paths(transactionInputSchema, { ...income, payers })).toEqual(['payers'])
    expect(paths(transactionInputSchema, { ...adjustment, payers })).toEqual(['payers'])
    expect(paths(transactionInputSchema, { ...loan, payers })).toEqual([])
    expect(paths(transactionInputSchema, { ...shift, totalCents: 12_500 })).toEqual(['totalCents'])
    expect(() => transactionInputSchema.parse({ ...expense, shift: shift.shift })).toThrow(
      'Not allowed for an expense',
    )
    expect(() => transactionInputSchema.parse({ ...adjustment, adjustment: undefined })).toThrow(
      'Required for an adjustment',
    )
    expect(() => transactionInputSchema.parse({ ...payment, split: loan.split })).toThrow(
      'Not allowed for a payment',
    )
  })

  it('requires totalCents unless the kind is shift or there are items', () => {
    expect(paths(transactionInputSchema, { ...expense, totalCents: undefined })).toEqual([
      'totalCents',
    ])
    expect(paths(transactionInputSchema, { ...income, totalCents: undefined })).toEqual([
      'totalCents',
    ])
    expect(paths(transactionInputSchema, { ...itemised, totalCents: 350 })).toEqual([])
  })

  it('allows days splits on bills only, including on items', () => {
    const daysItem = { name: 'Power', amountCents: 9000, split: { mode: 'days' } }
    expect(paths(transactionInputSchema, { ...bill, split: undefined, items: [daysItem] })).toEqual(
      [],
    )
    expect(paths(transactionInputSchema, { ...expense, split: { mode: 'days' } })).toEqual([
      'split.mode',
    ])
    expect(
      paths(transactionInputSchema, { ...itemised, items: [...itemised.items, daysItem] }),
    ).toEqual(['items.2.split.mode'])
    expect(() => transactionInputSchema.parse({ ...expense, split: { mode: 'days' } })).toThrow(
      'Only bills can split by days',
    )
  })

  it('allows at most 15 people across the whole transaction', () => {
    const others = Array.from({ length: 15 }, (_, index) => `p${index}`)
    const split = { mode: 'equal', personIds: others }
    expect(paths(transactionInputSchema, { ...expense, split })).toEqual([''])
    expect(
      paths(transactionInputSchema, { ...expense, split: { mode: 'equal', personIds: ['alice'] } }),
    ).toEqual([])
    expect(() => transactionInputSchema.parse({ ...expense, split })).toThrow(
      'At most 15 people per transaction',
    )
  })

  it('counts the people named in items too', () => {
    const item = (first: number) => ({
      name: 'Share',
      amountCents: 100,
      split: {
        mode: 'equal',
        personIds: Array.from({ length: 8 }, (_, index) => `p${first + index}`),
      },
    })
    expect(paths(transactionInputSchema, { ...itemised, items: [item(0), item(7)] })).toEqual([])
    expect(paths(transactionInputSchema, { ...itemised, items: [item(0), item(8)] })).toEqual([''])
  })

  it('allows 1 to 30 items', () => {
    const items = Array.from({ length: 31 }, () => itemised.items[0])
    expect(paths(transactionInputSchema, { ...itemised, items: items.slice(0, 30) })).toEqual([])
    expect(paths(transactionInputSchema, { ...itemised, items })).toEqual(['items'])
    expect(paths(transactionInputSchema, { ...itemised, items: [] })).toEqual(['items'])
  })

  it('caps the sum of the items like a typed total', () => {
    const [item] = itemised.items
    const huge = { ...item, amountCents: MAX_AMOUNT_CENTS }
    expect(
      paths(transactionInputSchema, { ...itemised, items: [huge, { ...huge, amountCents: -1 }] }),
    ).toEqual([])
    expect(paths(transactionInputSchema, { ...itemised, items: [huge, huge] })).toEqual(['items'])
    expect(() => transactionInputSchema.parse({ ...itemised, items: [huge, huge] })).toThrow(
      `The total must be at most ${MAX_AMOUNT_CENTS} cents in size`,
    )
    // One clear issue for a bad item, not a second one for the sum.
    expect(
      paths(transactionInputSchema, {
        ...itemised,
        items: [huge, { ...huge, amountCents: MAX_AMOUNT_CENTS + 1 }],
      }),
    ).toEqual(['items.1.amountCents'])
  })

  it('names each payer once', () => {
    const payers = [
      { personId: 'alice', cents: 5000 },
      { personId: 'alice', cents: 4000 },
    ]
    expect(paths(transactionInputSchema, { ...expense, payers })).toEqual(['payers'])
  })

  it('checks the shift part', () => {
    const withShift = (part: object) => ({ ...shift, shift: { ...shift.shift, ...part } })
    expect(paths(transactionInputSchema, withShift({ minutes: 24 * 60 }))).toEqual([])
    expect(paths(transactionInputSchema, withShift({ minutes: 24 * 60 + 1 }))).toEqual([
      'shift.minutes',
    ])
    expect(paths(transactionInputSchema, withShift({ breakMinutes: -1 }))).toEqual([
      'shift.breakMinutes',
    ])
    expect(paths(transactionInputSchema, withShift({ rateCents: -1 }))).toEqual(['shift.rateCents'])
    expect(paths(transactionInputSchema, withShift({ startTime: '24:00' }))).toEqual([
      'shift.startTime',
    ])
    expect(paths(transactionInputSchema, withShift({ endTime: '9:00' }))).toEqual(['shift.endTime'])
  })

  it("caps the shift's computed amount like a typed total", () => {
    const withShift = (part: object) => ({ ...shift, shift: { ...shift.shift, ...part } })
    // 1440 minutes at 416,666,666 cents an hour is 9,999,999,984 cents.
    expect(
      paths(transactionInputSchema, withShift({ minutes: 1440, rateCents: 416_666_666 })),
    ).toEqual([])
    expect(
      paths(transactionInputSchema, withShift({ minutes: 1440, rateCents: 416_666_667 })),
    ).toEqual(['shift'])
    expect(() =>
      transactionInputSchema.parse(withShift({ minutes: 1440, rateCents: MAX_AMOUNT_CENTS })),
    ).toThrow('The total must be at most')
  })

  it('reports a bill part on another kind once, as not allowed', () => {
    const dueWithoutDate = { status: 'due' }
    expect(paths(transactionInputSchema, { ...expense, bill: dueWithoutDate })).toEqual(['bill'])
  })

  it('needs dueOn on a due bill and the period for a days split', () => {
    const withBill = (part: object) => ({ ...bill, bill: { ...bill.bill, ...part } })
    expect(paths(transactionInputSchema, withBill({ dueOn: undefined }))).toEqual(['bill.dueOn'])
    expect(paths(transactionInputSchema, withBill({ status: 'paid', dueOn: undefined }))).toEqual(
      [],
    )
    expect(paths(transactionInputSchema, withBill({ periodEnd: undefined }))).toEqual(['bill'])
    expect(paths(transactionInputSchema, withBill({ periodStart: undefined }))).toEqual(['bill'])
    const daysItem = { name: 'Power', amountCents: 9000, split: { mode: 'days' } }
    const noPeriod = { status: 'due', dueOn: '2026-11-14' }
    expect(
      paths(transactionInputSchema, {
        ...bill,
        bill: noPeriod,
        split: undefined,
        items: [daysItem],
      }),
    ).toEqual(['bill'])
    expect(paths(transactionInputSchema, { ...bill, bill: noPeriod, split: loan.split })).toEqual(
      [],
    )
    expect(() => transactionInputSchema.parse(withBill({ dueOn: undefined }))).toThrow(
      'A due bill needs dueOn',
    )
  })

  it('checks the bill part', () => {
    const withBill = (part: object) => ({ ...bill, bill: { ...bill.bill, ...part } })
    expect(paths(transactionInputSchema, withBill({ status: 'paid' }))).toEqual([])
    expect(paths(transactionInputSchema, withBill({ status: 'overdue' }))).toEqual(['bill.status'])
    expect(paths(transactionInputSchema, withBill({ periodEnd: '2026-06-30' }))).toContain(
      'bill.periodEnd',
    )
    expect(paths(transactionInputSchema, withBill({ periodEnd: '2026-07-01' }))).toEqual([])
  })

  it('needs two different people for a payment', () => {
    const toSelf = { ...payment, payment: { fromPersonId: 'bob', toPersonId: 'bob' } }
    expect(paths(transactionInputSchema, toSelf)).toContain('payment.toPersonId')
    expect(() => transactionInputSchema.parse(toSelf)).toThrow(
      'A payment needs two different people',
    )
  })

  it('needs a reason and each person once in an adjustment', () => {
    const withAdjustment = (part: object) => ({
      ...adjustment,
      adjustment: { ...adjustment.adjustment, ...part },
    })
    expect(paths(transactionInputSchema, withAdjustment({ reason: ' ' }))).toEqual([
      'adjustment.reason',
    ])
    const [first] = adjustment.adjustment.shares
    expect(paths(transactionInputSchema, withAdjustment({ shares: [first, first] }))).toEqual([
      'adjustment.shares',
    ])
  })

  it('allows notes up to 1000 characters', () => {
    expect(paths(transactionInputSchema, { ...expense, note: 'x'.repeat(1000) })).toEqual([])
    expect(paths(transactionInputSchema, { ...expense, note: 'x'.repeat(1001) })).toEqual(['note'])
  })

  it('allows up to 10 receipt file IDs', () => {
    expect(paths(transactionInputSchema, { ...expense, receiptFileIds: ['../x'] })).toEqual([
      'receiptFileIds.0',
    ])
    const files = Array.from({ length: 11 }, (_, index) => `file${index}`)
    expect(
      paths(transactionInputSchema, { ...expense, receiptFileIds: files.slice(0, 10) }),
    ).toEqual([])
    expect(paths(transactionInputSchema, { ...expense, receiptFileIds: files })).toEqual([
      'receiptFileIds',
    ])
  })
})

describe('transactionTemplateSchema', () => {
  it('accepts the parts of a transaction a schedule repeats', () => {
    expect(paths(transactionTemplateSchema, { shift: shift.shift, category: 'work' })).toEqual([])
    expect(paths(transactionTemplateSchema, {})).toEqual([])
  })

  it('rejects the fields that live on the schedule', () => {
    expect(paths(transactionTemplateSchema, { kind: 'shift', shift: shift.shift })).toEqual([''])
    expect(paths(transactionTemplateSchema, { date: '2026-10-29' })).toEqual([''])
    expect(paths(transactionTemplateSchema, { totalCents: 1.5 })).toEqual(['totalCents'])
  })
})

describe('itemInputSchema', () => {
  const item = itemised.items[0]

  it('accepts an item', () => {
    expect(itemInputSchema.parse(item)).toEqual(item)
  })

  it('rejects a missing name or split, and a quantity of zero', () => {
    expect(paths(itemInputSchema, { ...item, name: '' })).toEqual(['name'])
    expect(paths(itemInputSchema, { ...item, name: 'x'.repeat(121) })).toEqual(['name'])
    expect(paths(itemInputSchema, { ...item, split: undefined })).toEqual(['split'])
    expect(paths(itemInputSchema, { ...item, quantity: 0 })).toEqual(['quantity'])
  })
})

describe('postTransactionBodySchema', () => {
  it('accepts an empty body or the parts that may change when posting', () => {
    expect(paths(postTransactionBodySchema, {})).toEqual([])
    expect(
      paths(postTransactionBodySchema, {
        date: '2026-10-30',
        payers: [{ personId: 'alice', cents: 9000 }],
        shift: { minutes: 240, rateCents: 2600, breakMinutes: 15 },
      }),
    ).toEqual([])
  })

  it('rejects anything else', () => {
    expect(paths(postTransactionBodySchema, { shift: { hours: 4 } })).toEqual(['shift'])
    expect(paths(postTransactionBodySchema, { totalCents: 100 })).toEqual([''])
    expect(paths(postTransactionBodySchema, { date: '30/10/2026' })).toEqual(['date'])
  })
})

describe('voidTransactionBodySchema', () => {
  it('needs a reason of 1–200 characters', () => {
    expect(paths(voidTransactionBodySchema, { reason: 'Entered twice' })).toEqual([])
    expect(paths(voidTransactionBodySchema, {})).toEqual(['reason'])
    expect(paths(voidTransactionBodySchema, { reason: ' ' })).toEqual(['reason'])
    expect(paths(voidTransactionBodySchema, { reason: 'x'.repeat(201) })).toEqual(['reason'])
  })
})

describe('startTimerBodySchema', () => {
  it('needs an id and a group', () => {
    expect(paths(startTimerBodySchema, { id: 'tx2', groupId: 'acme' })).toEqual([])
    expect(
      paths(startTimerBodySchema, {
        id: 'tx2',
        groupId: 'acme',
        rateCents: 2600,
        description: 'Market stall',
      }),
    ).toEqual([])
    expect(paths(startTimerBodySchema, { groupId: 'acme' })).toEqual(['id'])
    expect(paths(startTimerBodySchema, { id: 'tx2', groupId: 'acme', description: '' })).toEqual([
      'description',
    ])
  })
})

describe('stopTimerBodySchema', () => {
  it('needs the running transaction', () => {
    expect(paths(stopTimerBodySchema, { transactionId: 'tx2', breakMinutes: 30 })).toEqual([])
    expect(paths(stopTimerBodySchema, { breakMinutes: 30 })).toEqual(['transactionId'])
    expect(paths(stopTimerBodySchema, { transactionId: 'tx2', breakMinutes: -5 })).toEqual([
      'breakMinutes',
    ])
  })
})
