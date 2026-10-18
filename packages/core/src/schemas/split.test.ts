import { describe, expect, it } from 'vitest'
import { type SplitSpec, splitPersonIds, splitSpecSchema } from './split'

const valid: SplitSpec[] = [
  { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
  {
    mode: 'exact',
    amounts: [
      { personId: 'alice', cents: 6000 },
      { personId: 'bob', cents: 3000 },
    ],
  },
  { mode: 'exact', amounts: [{ personId: 'alice', cents: -1000 }] }, // a refund
  {
    mode: 'percent',
    percents: [
      { personId: 'alice', basisPoints: 6000 },
      { personId: 'bob', basisPoints: 4000 },
    ],
  },
  {
    mode: 'weights',
    weights: [
      { personId: 'alice', weight: 92 },
      { personId: 'cara', weight: 61 },
    ],
  },
  { mode: 'days' },
  { mode: 'days', personIds: ['alice', 'bob'] },
]

const paths = (value: unknown) =>
  splitSpecSchema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? []

describe('splitSpecSchema', () => {
  it.each(valid)('accepts %j', (split) => {
    expect(splitSpecSchema.parse(split)).toEqual(split)
  })

  it('rejects an unknown mode or an extra key', () => {
    expect(paths({ mode: 'shares', personIds: ['alice'] })).toEqual(['mode'])
    expect(paths({ mode: 'equal', personIds: ['alice'], weights: [] })).toEqual([''])
  })

  it('rejects an equal split with nobody or the same person twice', () => {
    expect(paths({ mode: 'equal', personIds: [] })).toEqual(['personIds'])
    expect(paths({ mode: 'equal', personIds: ['alice', 'alice'] })).toEqual(['personIds'])
  })

  it('rejects exact amounts that are not whole cents', () => {
    expect(paths({ mode: 'exact', amounts: [{ personId: 'alice', cents: 10.5 }] })).toEqual([
      'amounts.0.cents',
    ])
  })

  it('rejects percentages that do not add up to 100%', () => {
    const percents = [
      { personId: 'alice', basisPoints: 5000 },
      { personId: 'bob', basisPoints: 4999 },
    ]
    expect(() => splitSpecSchema.parse({ mode: 'percent', percents })).toThrow(
      'Percentages must add up to 100%',
    )
    expect(
      paths({ mode: 'percent', percents: [{ personId: 'alice', basisPoints: 10001 }] }),
    ).toContain('percents.0.basisPoints')
  })

  it('rejects weights below 1 or above MAX_WEIGHT', () => {
    expect(paths({ mode: 'weights', weights: [{ personId: 'alice', weight: 0 }] })).toEqual([
      'weights.0.weight',
    ])
    expect(paths({ mode: 'weights', weights: [{ personId: 'alice', weight: 10_001 }] })).toEqual([
      'weights.0.weight',
    ])
  })

  it('rejects a days split that names nobody', () => {
    expect(paths({ mode: 'days', personIds: [] })).toEqual(['personIds'])
  })
})

describe('splitPersonIds', () => {
  it('lists everyone the split names', () => {
    expect(valid.map(splitPersonIds)).toEqual([
      ['alice', 'bob', 'cara'],
      ['alice', 'bob'],
      ['alice'],
      ['alice', 'bob'],
      ['alice', 'cara'],
      [],
      ['alice', 'bob'],
    ])
  })
})
