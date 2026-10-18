import { describe, expect, it } from 'vitest'
import { assertShareInvariants } from './invariants'
import { LedgerError } from './ledger-error'

const members = ['alice', 'bob']
const share = (personId: string, givenCents: number, receivedCents: number) => ({
  personId,
  givenCents,
  receivedCents,
})

const expectBroken = (run: () => unknown, rule: string) => {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LedgerError)
  expect((caught as LedgerError).code).toBe('INVARIANT_VIOLATION')
  expect((caught as LedgerError).message).toContain(rule)
}

describe('assertShareInvariants', () => {
  it('passes balanced shares, refunds, empty transactions and mixed-sign adjustments', () => {
    expect(() =>
      assertShareInvariants(
        { kind: 'expense', totalCents: 9000 },
        [share('alice', 9000, 4500), share('bob', 0, 4500)],
        members,
      ),
    ).not.toThrow()
    expect(() =>
      assertShareInvariants(
        { kind: 'expense', totalCents: -2000 },
        [share('alice', -2000, -1000), share('bob', 0, -1000)],
        members,
      ),
    ).not.toThrow()
    expect(() =>
      assertShareInvariants({ kind: 'expense', totalCents: 0 }, [], members),
    ).not.toThrow()
    expect(() =>
      assertShareInvariants(
        { kind: 'adjustment', totalCents: 300 },
        [share('alice', 500, -200), share('bob', -200, 500)],
        members,
      ),
    ).not.toThrow()
  })

  it('I-1: given and received both equal the total', () => {
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: 100 },
          [share('alice', 100, 90)],
          members,
        ),
      'I-1',
    )
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: 100 },
          [share('alice', 90, 100)],
          members,
        ),
      'I-1',
    )
  })

  it('I-2: whole cents only', () => {
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: 1.5 },
          [share('alice', 1.5, 1.5)],
          members,
        ),
      'I-2',
    )
  })

  it('I-3: members only', () => {
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: 100 },
          [share('zoe', 100, 100)],
          members,
        ),
      'I-3',
    )
  })

  it('I-4: one sign, outside adjustments', () => {
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: 100 },
          [share('alice', 150, 100), share('bob', -50, 0)],
          members,
        ),
      'I-4',
    )
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: -100 },
          [share('alice', -150, -100), share('bob', 50, 0)],
          members,
        ),
      'I-4',
    )
  })

  it('I-5: one share per person', () => {
    expectBroken(
      () =>
        assertShareInvariants(
          { kind: 'expense', totalCents: 100 },
          [share('alice', 100, 50), share('alice', 0, 50)],
          members,
        ),
      'I-5',
    )
  })
})
