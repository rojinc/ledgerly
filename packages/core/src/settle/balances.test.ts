import { describe, expect, it } from 'vitest'
import { LedgerError } from '../ledger/ledger-error'
import { balancesPeopleSchema } from '../schemas/ledger'
import { applyShares, balancesFromShares } from './balances'
import { netsFromShares } from './nets'

// Electricity $90, Alice paid, split 3 ways; then Bob pays Alice $30 (ledger.md#worked-examples).
const electricity = [
  { personId: 'cara', givenCents: 0, receivedCents: 3000 },
  { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
  { personId: 'bob', givenCents: 0, receivedCents: 3000 },
]
const payment = [
  { personId: 'bob', givenCents: 3000, receivedCents: 0 },
  { personId: 'alice', givenCents: 0, receivedCents: 3000 },
]
const row = [
  { personId: 'alice', netCents: 3000, shares: 2 },
  { personId: 'bob', netCents: 0, shares: 2 },
  { personId: 'cara', netCents: -3000, shares: 1 },
]

describe('balancesFromShares', () => {
  it('counts each person’s shares and nets, in ascending personId order', () => {
    const people = balancesFromShares([...electricity, ...payment])
    expect(people).toEqual(row)
    // The same nets as summing on read, and a valid peopleJson.
    expect(people.map(({ personId, netCents }) => ({ personId, netCents }))).toEqual(
      netsFromShares([...electricity, ...payment]),
    )
    expect(balancesPeopleSchema.parse(people)).toEqual(people)
  })

  it('handles refunds and a group with no shares', () => {
    expect(
      balancesFromShares([
        { personId: 'alice', givenCents: -2000, receivedCents: -1000 },
        { personId: 'bob', givenCents: 0, receivedCents: -1000 },
      ]),
    ).toEqual([
      { personId: 'alice', netCents: -1000, shares: 1 },
      { personId: 'bob', netCents: 1000, shares: 1 },
    ])
    expect(balancesFromShares([])).toEqual([])
  })
})

describe('applyShares', () => {
  const electricityRow = balancesFromShares(electricity)

  it('adds a new transaction’s shares', () => {
    expect(applyShares(electricityRow, [], payment)).toEqual(row)
  })

  it('takes a voided transaction’s shares off, and drops whoever has none left', () => {
    expect(applyShares(row, payment, [])).toEqual(electricityRow)
    expect(applyShares(electricityRow, electricity, [])).toEqual([])
  })

  it('moves an edit’s shares from the people it had to the ones it has now', () => {
    // The payment becomes Cara's, to Alice, for $25.
    const edited = [
      { personId: 'cara', givenCents: 2500, receivedCents: 0 },
      { personId: 'alice', givenCents: 0, receivedCents: 2500 },
    ]
    expect(applyShares(row, payment, edited)).toEqual([
      { personId: 'alice', netCents: 3500, shares: 2 },
      { personId: 'bob', netCents: -3000, shares: 1 },
      { personId: 'cara', netCents: -500, shares: 2 },
    ])
  })

  it('keeps someone whose shares still net to 0', () => {
    expect(applyShares(row, payment, payment)).toEqual(row)
    expect(row.find((person) => person.personId === 'bob')).toEqual({
      personId: 'bob',
      netCents: 0,
      shares: 2,
    })
  })

  it('turns a merged placeholder’s balance into the person’s, combining shares in one transaction', () => {
    // Pat (a placeholder) and Alice both had a share of the electricity; a merge combines them.
    const before = [
      { personId: 'pat', givenCents: 0, receivedCents: 3000 },
      { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
    ]
    const people = balancesFromShares([
      ...before,
      { personId: 'bob', givenCents: 0, receivedCents: 3000 },
    ])
    expect(
      applyShares(people, before, [{ personId: 'alice', givenCents: 9000, receivedCents: 6000 }]),
    ).toEqual([
      { personId: 'alice', netCents: 3000, shares: 1 },
      { personId: 'bob', netCents: -3000, shares: 1 },
    ])
  })

  it('leaves its input alone', () => {
    const people = structuredClone(row)
    applyShares(people, payment, [])
    expect(people).toEqual(row)
  })

  it('refuses a row that doesn’t fit the shares', () => {
    const misfit = (people: typeof row, before: typeof payment) => {
      try {
        applyShares(people, before, [])
      } catch (error) {
        return error instanceof LedgerError ? error.code : error
      }
      return 'no error'
    }
    // Someone the row doesn't have loses a share.
    expect(misfit([], payment)).toBe('INVARIANT_VIOLATION')
    // Someone dropped still has a net.
    expect(misfit([{ personId: 'bob', netCents: 100, shares: 1 }], payment.slice(0, 1))).toBe(
      'INVARIANT_VIOLATION',
    )
  })
})
