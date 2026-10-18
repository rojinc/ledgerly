import { describe, expect, it } from 'vitest'
import { netsFromShares } from './nets'

describe('netsFromShares', () => {
  it('adds up given − received per person, sorted by personId', () => {
    const shares = [
      // Electricity $90, Alice paid, split 3 ways (ledger.md#worked-examples)
      { personId: 'cara', givenCents: 0, receivedCents: 3000 },
      { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
      { personId: 'bob', givenCents: 0, receivedCents: 3000 },
      // Bob pays Alice $30
      { personId: 'bob', givenCents: 3000, receivedCents: 0 },
      { personId: 'alice', givenCents: 0, receivedCents: 3000 },
    ]
    expect(netsFromShares(shares)).toEqual([
      { personId: 'alice', netCents: 3000 },
      { personId: 'bob', netCents: 0 },
      { personId: 'cara', netCents: -3000 },
    ])
  })

  it('handles refunds and an empty group', () => {
    expect(
      netsFromShares([
        { personId: 'alice', givenCents: -2000, receivedCents: -1000 },
        { personId: 'bob', givenCents: 0, receivedCents: -1000 },
      ]),
    ).toEqual([
      { personId: 'alice', netCents: -1000 },
      { personId: 'bob', netCents: 1000 },
    ])
    expect(netsFromShares([])).toEqual([])
  })
})
