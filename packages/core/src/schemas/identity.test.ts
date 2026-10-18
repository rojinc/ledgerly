import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  acceptInviteBodySchema,
  bootstrapBodySchema,
  businessDetailsSchema,
  createInviteBodySchema,
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
  it('needs a group, a member and a channel', () => {
    expect(
      paths(createInviteBodySchema, { groupId: 'house1', memberId: 'm1', channel: 'email' }),
    ).toEqual([])
    expect(
      paths(createInviteBodySchema, { groupId: 'house1', memberId: 'm1', channel: 'fax' }),
    ).toEqual(['channel'])
    expect(paths(createInviteBodySchema, { groupId: 'house1', channel: 'sms' })).toEqual([
      'memberId',
    ])
  })
})

describe('acceptInviteBodySchema', () => {
  it('needs a 32-byte base64url token', () => {
    const token = 'Ab9_-'.repeat(8).concat('xyz')
    expect(paths(acceptInviteBodySchema, { token })).toEqual([])
    expect(paths(acceptInviteBodySchema, { token: token.slice(1) })).toEqual(['token'])
    expect(paths(acceptInviteBodySchema, { token: `${token.slice(1)}=` })).toEqual(['token'])
  })
})
