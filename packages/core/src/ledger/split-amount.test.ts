import { describe, expect, it } from 'vitest'
import { parseLocalDate } from '../dates/local-date'
import { LedgerError } from './ledger-error'
import { type LedgerMember, splitAmount } from './split-amount'

const d = parseLocalDate
const member = (personId: string, joinedOn = '2026-01-01', leftOn: string | null = null) => ({
  personId,
  joinedOn: d(joinedOn),
  leftOn: leftOn === null ? null : d(leftOn),
})
const house: LedgerMember[] = [member('alice'), member('bob'), member('cara', '2026-08-01')]
const q3 = { start: d('2026-07-01'), end: d('2026-09-30') }

const expectInvalid = (run: () => unknown) => {
  expect(run).toThrow(LedgerError)
  try {
    run()
  } catch (error) {
    expect((error as LedgerError).code).toBe('VALIDATION_FAILED')
  }
}

describe('splitAmount', () => {
  it('splits equally, leftover cents to the first in the spec', () => {
    expect(
      splitAmount({ mode: 'equal', personIds: ['a', 'b', 'c'] }, 1000, { members: [] }),
    ).toEqual([
      { personId: 'a', cents: 334 },
      { personId: 'b', cents: 333 },
      { personId: 'c', cents: 333 },
    ])
  })

  it('splits by percentages in basis points, allowing 0%', () => {
    const spec = {
      mode: 'percent' as const,
      percents: [
        { personId: 'a', basisPoints: 2500 },
        { personId: 'b', basisPoints: 7500 },
        { personId: 'c', basisPoints: 0 },
      ],
    }
    expect(splitAmount(spec, 1001, { members: [] })).toEqual([
      { personId: 'a', cents: 250 },
      { personId: 'b', cents: 751 },
      { personId: 'c', cents: 0 },
    ])
  })

  it('splits by weights', () => {
    const spec = {
      mode: 'weights' as const,
      weights: [
        { personId: 'a', weight: 1 },
        { personId: 'b', weight: 2 },
      ],
    }
    expect(splitAmount(spec, 100, { members: [] })).toEqual([
      { personId: 'a', cents: 33 },
      { personId: 'b', cents: 67 },
    ])
  })

  it('takes exact amounts as given, and they must add up', () => {
    const amounts = [
      { personId: 'a', cents: 700 },
      { personId: 'b', cents: 300 },
    ]
    expect(splitAmount({ mode: 'exact', amounts }, 1000, { members: [] })).toEqual(amounts)
    expectInvalid(() => splitAmount({ mode: 'exact', amounts }, 999, { members: [] }))
  })

  it('splits negative amounts with the same sign', () => {
    expect(
      splitAmount({ mode: 'equal', personIds: ['a', 'b', 'c'] }, -200, { members: [] }),
    ).toEqual([
      { personId: 'a', cents: -67 },
      { personId: 'b', cents: -67 },
      { personId: 'c', cents: -66 },
    ])
  })

  describe('days present', () => {
    it('weights everyone by the days they were there (ledger.md example: 92 : 92 : 61)', () => {
      expect(splitAmount({ mode: 'days' }, 27000, { members: house, period: q3 })).toEqual([
        { personId: 'alice', cents: 10139 },
        { personId: 'bob', cents: 10139 },
        { personId: 'cara', cents: 6722 },
      ])
    })

    it('counts a member who left during the period up to their leaving day', () => {
      const members = [member('alice'), member('bob', '2026-01-01', '2026-07-31')]
      // 92 : 31 days
      expect(splitAmount({ mode: 'days' }, 12300, { members, period: q3 })).toEqual([
        { personId: 'alice', cents: 9200 },
        { personId: 'bob', cents: 3100 },
      ])
    })

    it('leaves out members with no days in the period', () => {
      const members = [...house, member('dan', '2026-10-01')]
      const parts = splitAmount({ mode: 'days' }, 27000, { members, period: q3 })
      expect(parts.map((part) => part.personId)).toEqual(['alice', 'bob', 'cara'])
    })

    it('can be limited to named members', () => {
      expect(
        splitAmount({ mode: 'days', personIds: ['cara', 'alice'] }, 1530, {
          members: house,
          period: q3,
        }),
      ).toEqual([
        { personId: 'cara', cents: 610 },
        { personId: 'alice', cents: 920 },
      ])
    })

    it('fails without a period, for non-members, or when nobody was there', () => {
      expectInvalid(() => splitAmount({ mode: 'days' }, 100, { members: house }))
      expectInvalid(() =>
        splitAmount({ mode: 'days', personIds: ['zoe'] }, 100, { members: house, period: q3 }),
      )
      expectInvalid(() =>
        splitAmount({ mode: 'days' }, 100, { members: [member('dan', '2026-10-01')], period: q3 }),
      )
    })
  })
})
