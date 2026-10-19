import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  acceptInviteBodySchema,
  bootstrapBodySchema,
  businessDetailsSchema,
  createInviteBodySchema,
  deleteAccountBodySchema,
  hoursCapSchema,
  mergeCursorsSchema,
  mergeMembersSchema,
  sendReminderBodySchema,
  updateProfileBodySchema,
} from './identity'

const paths = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? []

const business = {
  businessName: 'Sam Lee Cleaning',
  abn: '51 824 753 556',
  address: '1 Example Street\nUnit 2',
  email: 'sam@example.com',
  phone: '0412 345 678',
  bank: { accountName: 'Sam Lee', bsb: '062-000', accountNumber: '1234 5678' },
  payId: 'sam@example.com',
  invoiceNotes: 'Thanks for your business.',
}

describe('businessDetailsSchema', () => {
  it('accepts business details and keeps only the digits of numbers', () => {
    expect(businessDetailsSchema.parse(business)).toEqual({
      ...business,
      abn: '51824753556',
      bank: { accountName: 'Sam Lee', bsb: '062000', accountNumber: '12345678' },
    })
    expect(businessDetailsSchema.parse({})).toEqual({})
  })

  it('rejects numbers with the wrong digits', () => {
    expect(paths(businessDetailsSchema, { abn: '5182475355' })).toEqual(['abn'])
    expect(paths(businessDetailsSchema, { abn: '51 824 753 55X' })).toEqual(['abn'])
    expect(paths(businessDetailsSchema, { bank: { ...business.bank, bsb: '06200' } })).toEqual([
      'bank.bsb',
    ])
    expect(
      paths(businessDetailsSchema, { bank: { ...business.bank, accountNumber: '1'.repeat(13) } }),
    ).toEqual(['bank.accountNumber'])
  })

  it('rejects empty or overlong text and unknown keys', () => {
    expect(paths(businessDetailsSchema, { businessName: ' ' })).toEqual(['businessName'])
    expect(paths(businessDetailsSchema, { invoiceNotes: 'x'.repeat(1001) })).toEqual([
      'invoiceNotes',
    ])
    expect(paths(businessDetailsSchema, { email: 'sam' })).toEqual(['email'])
    expect(paths(businessDetailsSchema, { gst: true })).toEqual([''])
  })
})

describe('bootstrapBodySchema', () => {
  it('needs the browser time zone', () => {
    expect(paths(bootstrapBodySchema, { timezone: 'Australia/Sydney' })).toEqual([])
    expect(paths(bootstrapBodySchema, {})).toEqual(['timezone'])
    expect(paths(bootstrapBodySchema, { timezone: 'Mars/Base' })).toEqual(['timezone'])
  })
})

describe('updateProfileBodySchema', () => {
  it('accepts any subset of the profile fields', () => {
    expect(paths(updateProfileBodySchema, {})).toEqual([])
    expect(
      paths(updateProfileBodySchema, {
        displayName: 'Sam Lee',
        timezone: 'Australia/Perth',
        region: 'AU-WA',
        currency: 'AUD',
        business,
        invoicePrefix: '',
        summaryFrequency: 'fortnightly',
      }),
    ).toEqual([])
  })

  it('rejects invalid fields', () => {
    expect(paths(updateProfileBodySchema, { invoicePrefix: 'x'.repeat(17) })).toEqual([
      'invoicePrefix',
    ])
    expect(paths(updateProfileBodySchema, { summaryFrequency: 'daily' })).toEqual([
      'summaryFrequency',
    ])
    expect(paths(updateProfileBodySchema, { lastInvoiceNumber: 10 })).toEqual([''])
  })
})

describe('createInviteBodySchema', () => {
  const invite = { groupId: 'house1', memberId: 'm1' }

  it('needs a group, a member and exactly one address', () => {
    expect(paths(createInviteBodySchema, { ...invite, email: 'cara@example.com' })).toEqual([])
    expect(paths(createInviteBodySchema, { ...invite, phone: '0412 345 678' })).toEqual([])
    expect(paths(createInviteBodySchema, invite)).toEqual(['email'])
    expect(
      paths(createInviteBodySchema, {
        ...invite,
        email: 'cara@example.com',
        phone: '0412 345 678',
      }),
    ).toEqual(['email'])
    expect(() => createInviteBodySchema.parse(invite)).toThrow('Give exactly one of email or phone')
  })

  it('rejects a bad address, a missing member or the old channel field', () => {
    expect(paths(createInviteBodySchema, { ...invite, email: 'cara' })).toEqual(['email'])
    expect(paths(createInviteBodySchema, { groupId: 'house1', email: 'cara@example.com' })).toEqual(
      ['memberId'],
    )
    const withChannel = { ...invite, email: 'cara@example.com', channel: 'email' }
    expect(paths(createInviteBodySchema, withChannel)).toEqual([''])
  })
})

describe('sendReminderBodySchema', () => {
  const reminder = { id: 'r1', groupId: 'pair1', email: 'cara@example.com' }

  it('needs an id, a pair group and one email address', () => {
    expect(paths(sendReminderBodySchema, reminder)).toEqual([])
    expect(paths(sendReminderBodySchema, { ...reminder, email: 'cara' })).toEqual(['email'])
    expect(paths(sendReminderBodySchema, { groupId: 'pair1', email: 'cara@example.com' })).toEqual([
      'id',
    ])
    expect(paths(sendReminderBodySchema, { id: 'r1', groupId: 'pair1' })).toEqual(['email'])
  })

  it('takes no phone, note or amount: unknown keys fail', () => {
    for (const extra of [{ phone: '0412 345 678' }, { note: 'Pay up' }, { amountCents: 100 }]) {
      expect(paths(sendReminderBodySchema, { ...reminder, ...extra })).toEqual([''])
    }
  })
})

describe('acceptInviteBodySchema', () => {
  it('takes any token text, leaving unknown tokens to the function (INVITE_INVALID)', () => {
    expect(paths(acceptInviteBodySchema, { token: 'Ab9_-'.repeat(8).concat('xyz') })).toEqual([])
    expect(paths(acceptInviteBodySchema, { token: 'not-a-real-token' })).toEqual([])
    expect(paths(acceptInviteBodySchema, { token: 'x'.repeat(129) })).toEqual(['token'])
    expect(paths(acceptInviteBodySchema, {})).toEqual(['token'])
  })
})

describe('hoursCapSchema (#53)', () => {
  it('takes a week, or a fortnight from a Monday', () => {
    expect(paths(hoursCapSchema, { minutes: 2400, period: 'week' })).toEqual([])
    // 19 Oct 2026 is a Monday.
    expect(
      paths(hoursCapSchema, { minutes: 4800, period: 'fortnight', startsOn: '2026-10-19' }),
    ).toEqual([])
    expect(paths(hoursCapSchema, { minutes: 60, period: 'week' })).toEqual([])
    expect(paths(hoursCapSchema, { minutes: 10080, period: 'week' })).toEqual([])
    expect(
      paths(hoursCapSchema, { minutes: 20160, period: 'fortnight', startsOn: '2026-10-19' }),
    ).toEqual([])
  })

  it.each([
    ['under an hour', { minutes: 59, period: 'week' }, ['minutes']],
    ['over a week', { minutes: 10081, period: 'week' }, ['minutes']],
    [
      'over a fortnight',
      { minutes: 20161, period: 'fortnight', startsOn: '2026-10-19' },
      ['minutes'],
    ],
    ['part of a minute', { minutes: 2400.5, period: 'week' }, ['minutes']],
    ['a fortnight with no start', { minutes: 4800, period: 'fortnight' }, ['startsOn']],
    [
      'a fortnight from a Tuesday',
      { minutes: 4800, period: 'fortnight', startsOn: '2026-10-20' },
      ['startsOn'],
    ],
    [
      'a fortnight from a date that isn’t one',
      { minutes: 4800, period: 'fortnight', startsOn: '2026-02-30' },
      ['startsOn'],
    ],
    [
      'a week with a start',
      { minutes: 2400, period: 'week', startsOn: '2026-10-19' },
      ['startsOn'],
    ],
    ['a month', { minutes: 2400, period: 'month' }, ['period']],
    ['anything else', { minutes: 2400, period: 'week', note: 'x' }, ['']],
  ])('refuses %s', (_case, cap, expected) => {
    expect(paths(hoursCapSchema, cap)).toEqual(expected)
  })

  it('is set or cleared (null) through PATCH /profile, or left out', () => {
    expect(paths(updateProfileBodySchema, { hoursCap: { minutes: 2400, period: 'week' } })).toEqual(
      [],
    )
    expect(paths(updateProfileBodySchema, { hoursCap: null })).toEqual([])
    expect(paths(updateProfileBodySchema, { hoursCap: { minutes: 59, period: 'week' } })).toEqual([
      'hoursCap.minutes',
    ])
  })
})

describe('deleteAccountBodySchema (#50)', () => {
  it('takes only DELETE, typed exactly', () => {
    expect(paths(deleteAccountBodySchema, { confirm: 'DELETE' })).toEqual([])
    for (const confirm of ['delete', 'DELETE ', '', undefined, true]) {
      expect(paths(deleteAccountBodySchema, { confirm })).toEqual(['confirm'])
    }
    expect(paths(deleteAccountBodySchema, {})).toEqual(['confirm'])
    expect(paths(deleteAccountBodySchema, { confirm: 'DELETE', userId: 'u1' })).toEqual([''])
  })
})

describe('mergeMembersSchema', () => {
  const entry = {
    groupId: 'g1',
    from: { joinedOn: '2026-01-05', leftOn: null },
    into: { joinedOn: '2026-02-01', leftOn: '2026-03-31' },
  }

  it('takes P dates with or without U dates', () => {
    expect(mergeMembersSchema.parse([entry, { ...entry, groupId: 'g2', into: null }])).toHaveLength(
      2,
    )
    expect(mergeMembersSchema.parse([])).toEqual([])
  })

  it('refuses a missing date, a date that is not one, or another key', () => {
    expect(paths(mergeMembersSchema, [{ ...entry, from: { leftOn: null } }])).toEqual([
      '0.from.joinedOn',
    ])
    expect(
      paths(mergeMembersSchema, [{ ...entry, into: { joinedOn: '2026-02-30', leftOn: null } }]),
    ).toEqual(['0.into.joinedOn'])
    expect(paths(mergeMembersSchema, [{ ...entry, personId: 'p1' }])).toEqual(['0'])
  })
})

describe('mergeCursorsSchema', () => {
  const entry = { groupId: 'g1', after: 't9', left: [] }

  it('takes a cursor per group, with the rows left behind it', () => {
    expect(mergeCursorsSchema.parse([entry, { ...entry, groupId: 'g2', left: ['t3'] }])).toEqual([
      entry,
      { groupId: 'g2', after: 't9', left: ['t3'] },
    ])
    expect(mergeCursorsSchema.parse([])).toEqual([])
  })

  it('refuses a missing cursor, a left list that isn’t IDs, or another key', () => {
    expect(paths(mergeCursorsSchema, [{ groupId: 'g1', left: [] }])).toEqual(['0.after'])
    expect(paths(mergeCursorsSchema, [{ ...entry, left: [1] }])).toEqual(['0.left.0'])
    expect(paths(mergeCursorsSchema, [{ ...entry, done: true }])).toEqual(['0'])
  })
})
