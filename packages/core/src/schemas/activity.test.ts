import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS, MAX_PEOPLE_PER_TRANSACTION } from '../constants/limits'
import { type ChangeNets, changeNetsSchema } from './activity'

const nets = {
  before: [
    { personId: 'p-alex', netCents: 6000 },
    { personId: 'p-sam', netCents: -6000 },
  ],
  after: [],
} satisfies ChangeNets

describe('changeNetsSchema', () => {
  it('takes the nets before and after, a void leaving none after', () => {
    expect(changeNetsSchema.parse(nets)).toEqual(nets)
  })

  it('takes a net of 0, and nets past the largest amount, as an adjustment mixing signs makes', () => {
    const edges = {
      before: [{ personId: 'p-alex', netCents: 0 }],
      after: [
        { personId: 'p-alex', netCents: 2 * MAX_AMOUNT_CENTS },
        { personId: 'p-sam', netCents: -2 * MAX_AMOUNT_CENTS },
      ],
    }
    expect(changeNetsSchema.safeParse(edges).success).toBe(true)
  })

  it.each([
    ['a missing side', { before: nets.before }],
    ['an extra key', { ...nets, total: 0 }],
    ['an extra key on a net', { before: [{ ...nets.before[0], name: 'Alex' }], after: [] }],
    ['cents that are not whole', { before: [{ personId: 'p-alex', netCents: 0.5 }], after: [] }],
    ['a person ID that is not an ID', { before: [{ personId: '', netCents: 0 }], after: [] }],
    ['people out of order', { before: [...nets.before].reverse(), after: [] }],
    ['a person twice', { before: [nets.before[0], nets.before[0]], after: [] }],
  ])('refuses %s', (_case, value) => {
    expect(changeNetsSchema.safeParse(value).success).toBe(false)
  })

  it(`takes at most ${MAX_PEOPLE_PER_TRANSACTION} people a side`, () => {
    const people = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        personId: `p-${String(index).padStart(2, '0')}`,
        netCents: 0,
      }))
    const most = { before: people(MAX_PEOPLE_PER_TRANSACTION), after: [] }
    const tooMany = { before: [], after: people(MAX_PEOPLE_PER_TRANSACTION + 1) }
    expect(changeNetsSchema.safeParse(most).success).toBe(true)
    expect(changeNetsSchema.safeParse(tooMany).success).toBe(false)
  })
})
