import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  addMemberBodySchema,
  createGroupBodySchema,
  type GroupSettings,
  groupSettingsSchema,
  statementCycleSchema,
  updateGroupBodySchema,
  updateMemberBodySchema,
} from './groups'

const paths = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? []

const employerSettings = {
  type: 'employer',
  defaultRateCents: 2500,
  paymentTermsDays: 14,
  autoFinalize: false,
  recipients: ['accounts@example.com'],
} satisfies GroupSettings

const houseSettings = {
  type: 'house',
  autoFinalize: true,
  defaultBillSplit: 'days',
} satisfies GroupSettings

describe('groupSettingsSchema', () => {
  it.each([employerSettings, houseSettings, { type: 'personal' }, { type: 'pair' }])(
    'accepts %j',
    (settings) => expect(groupSettingsSchema.parse(settings)).toEqual(settings),
  )

  it('rejects an unknown type or settings from another type', () => {
    expect(paths(groupSettingsSchema, { type: 'club' })).toEqual(['type'])
    expect(paths(groupSettingsSchema, { type: 'pair', autoFinalize: true })).toEqual([''])
  })

  it('checks employer settings', () => {
    const employer = (part: object) => ({ ...employerSettings, ...part })
    expect(paths(groupSettingsSchema, employer({ recipients: [] }))).toEqual([])
    expect(paths(groupSettingsSchema, employer({ recipients: ['not an email'] }))).toEqual([
      'recipients.0',
    ])
    const eleven = Array.from({ length: 11 }, (_, index) => `billing${index}@example.com`)
    expect(paths(groupSettingsSchema, employer({ recipients: eleven }))).toEqual(['recipients'])
    expect(paths(groupSettingsSchema, employer({ paymentTermsDays: 366 }))).toEqual([
      'paymentTermsDays',
    ])
    expect(paths(groupSettingsSchema, employer({ defaultRateCents: -1 }))).toEqual([
      'defaultRateCents',
    ])
  })

  it('checks house settings', () => {
    expect(paths(groupSettingsSchema, { ...houseSettings, defaultBillSplit: 'weights' })).toEqual([
      'defaultBillSplit',
    ])
  })
})

describe('createGroupBodySchema', () => {
  const employer = {
    id: 'acme',
    type: 'employer',
    name: 'Acme Pty Ltd',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: 'monthly',
    settings: employerSettings,
    counterpart: { displayName: 'Acme', email: 'accounts@example.com', phone: '02 9999 0000' },
  } satisfies z.input<typeof createGroupBodySchema>

  const house = {
    id: 'house1',
    type: 'house',
    name: 'Elm Street',
    statementCycle: 'fortnightly',
    cycleAnchor: '2026-10-05',
  } satisfies z.input<typeof createGroupBodySchema>

  const pair = {
    id: 'pair1',
    type: 'pair',
    name: 'Sam',
    counterpart: { displayName: 'Sam' },
  } satisfies z.input<typeof createGroupBodySchema>

  it.each([employer, house, pair])('accepts %j', (group) => {
    expect(createGroupBodySchema.parse(group)).toEqual(group)
  })

  it('never creates a personal group', () => {
    expect(paths(createGroupBodySchema, { ...house, type: 'personal' })).toEqual(['type'])
  })

  it('needs a counterpart for employer and pair groups only', () => {
    expect(paths(createGroupBodySchema, { ...employer, counterpart: undefined })).toEqual([
      'counterpart',
    ])
    expect(paths(createGroupBodySchema, { ...pair, counterpart: undefined })).toEqual([
      'counterpart',
    ])
    expect(paths(createGroupBodySchema, { ...house, counterpart: pair.counterpart })).toEqual([
      'counterpart',
    ])
    expect(() => createGroupBodySchema.parse({ ...employer, counterpart: undefined })).toThrow(
      'Required for a employer group',
    )
    expect(() => createGroupBodySchema.parse({ ...house, counterpart: pair.counterpart })).toThrow(
      'Only employer and pair groups have a counterpart',
    )
  })

  it('needs settings of the same type as the group', () => {
    expect(paths(createGroupBodySchema, { ...employer, settings: houseSettings })).toEqual([
      'settings.type',
    ])
    expect(paths(createGroupBodySchema, { ...house, settings: houseSettings })).toEqual([])
  })

  it('needs an anchor for weekly and fortnightly cycles', () => {
    expect(paths(createGroupBodySchema, { ...house, cycleAnchor: undefined })).toEqual([
      'cycleAnchor',
    ])
    expect(
      paths(createGroupBodySchema, { ...house, statementCycle: 'weekly', cycleAnchor: undefined }),
    ).toEqual(['cycleAnchor'])
    expect(
      paths(createGroupBodySchema, { ...house, statementCycle: 'none', cycleAnchor: undefined }),
    ).toEqual([])
    expect(() => createGroupBodySchema.parse({ ...house, cycleAnchor: undefined })).toThrow(
      'A fortnightly cycle needs cycleAnchor',
    )
  })

  it('checks each field', () => {
    expect(paths(createGroupBodySchema, { ...house, name: '' })).toEqual(['name'])
    expect(paths(createGroupBodySchema, { ...house, currency: 'aud' })).toEqual(['currency'])
    expect(paths(createGroupBodySchema, { ...house, timezone: 'Sydney' })).toEqual(['timezone'])
    expect(paths(createGroupBodySchema, { ...house, region: 'NSW' })).toEqual(['region'])
    expect(paths(createGroupBodySchema, { ...house, statementCycle: 'daily' })).toEqual([
      'statementCycle',
    ])
    expect(paths(createGroupBodySchema, { ...house, cycleAnchor: '5 Oct' })).toEqual([
      'cycleAnchor',
    ])
    expect(
      paths(createGroupBodySchema, { ...pair, counterpart: { displayName: 'Sam', email: 'sam' } }),
    ).toEqual(['counterpart.email'])
  })
})

describe('statementCycleSchema', () => {
  it('accepts the cycles in the data model', () => {
    expect(statementCycleSchema.options).toEqual(['none', 'weekly', 'fortnightly', 'monthly'])
    expect(statementCycleSchema.safeParse('daily').success).toBe(false)
  })
})

describe('updateGroupBodySchema', () => {
  it('accepts any subset of the group fields, currency included', () => {
    expect(paths(updateGroupBodySchema, {})).toEqual([])
    expect(paths(updateGroupBodySchema, { name: 'Elm St', currency: 'NZD' })).toEqual([])
    expect(paths(updateGroupBodySchema, { settings: houseSettings })).toEqual([])
  })

  it('rejects fields that never change or are invalid', () => {
    expect(paths(updateGroupBodySchema, { type: 'house' })).toEqual([''])
    expect(paths(updateGroupBodySchema, { name: ' ' })).toEqual(['name'])
  })
})

describe('addMemberBodySchema', () => {
  it('needs a display name', () => {
    expect(paths(addMemberBodySchema, { displayName: 'Cara' })).toEqual([])
    expect(
      paths(addMemberBodySchema, {
        displayName: 'Cara',
        email: 'cara@example.com',
        phone: '0412 345 678',
        role: 'member',
        joinedOn: '2026-08-01',
      }),
    ).toEqual([])
    expect(paths(addMemberBodySchema, {})).toEqual(['displayName'])
    expect(paths(addMemberBodySchema, { displayName: 'x'.repeat(101) })).toEqual(['displayName'])
    expect(paths(addMemberBodySchema, { displayName: 'Cara', role: 'owner' })).toEqual(['role'])
    // D-016: members are always added as placeholders, never linked to a user here.
    expect(paths(addMemberBodySchema, { displayName: 'Cara', userId: 'user1' })).toEqual([''])
  })
})

describe('updateMemberBodySchema', () => {
  it('accepts a move-out on or after the move-in', () => {
    expect(paths(updateMemberBodySchema, { leftOn: '2026-10-31' })).toEqual([])
    expect(
      paths(updateMemberBodySchema, {
        joinedOn: '2026-08-01',
        leftOn: '2026-08-01',
        role: 'viewer',
      }),
    ).toEqual([])
  })

  it('rejects a move-out before the move-in', () => {
    expect(paths(updateMemberBodySchema, { joinedOn: '2026-08-01', leftOn: '2026-07-31' })).toEqual(
      ['leftOn'],
    )
    expect(paths(updateMemberBodySchema, { status: 'left' })).toEqual([''])
  })
})
