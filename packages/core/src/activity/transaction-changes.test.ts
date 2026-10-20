import { describe, expect, it } from 'vitest'
import type { LocalDate } from '../dates/local-date'
import { type ChangeRow, transactionChanges } from './transaction-changes'

const day = (date: string) => date as LocalDate
const current = () => ({ totalCents: 9000, date: day('2026-10-20') })
const samePerson = (personId: string) => personId

// Alice paid $90.00 for groceries split with Bob, and Bob changes it.
const split = (cents: number) => [
  { personId: 'alice', netCents: cents / 2 },
  { personId: 'bob', netCents: -cents / 2 },
]

function edit(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    transactionId: 't1',
    actorPersonId: 'bob',
    voided: false,
    nets: { before: split(9000), after: split(12000) },
    totalCents: { before: 9000, after: 12000 },
    ...overrides,
  }
}

describe('transactionChanges', () => {
  it('tells the others in it, not the one who changed it', () => {
    const told = transactionChanges([edit()], current, samePerson)
    expect([...told.keys()]).toEqual(['alice'])
    expect(told.get('alice')).toEqual([
      {
        transactionId: 't1',
        changedBy: ['bob'],
        totalCents: { before: 9000, after: 12000 },
        date: { before: '2026-10-20', after: '2026-10-20' },
        netCents: { before: 4500, after: 6000 },
        voided: false,
      },
    ])
  })

  it('folds a window to the first before and the last after, field by field', () => {
    const rows = [
      edit({ nets: { before: split(9000), after: split(10000) } }),
      edit({
        actorPersonId: 'alice',
        nets: { before: split(10000), after: split(10000) },
        totalCents: undefined,
        date: { before: day('2026-10-20'), after: day('2026-10-19') },
      }),
      edit({
        nets: { before: split(10000), after: split(12000) },
        totalCents: { before: 10000, after: 12000 },
      }),
    ]
    const told = transactionChanges(rows, current, samePerson)
    // Both changed it, so each is told about the other's changes.
    expect(told.get('alice')?.[0]).toMatchObject({
      changedBy: ['bob'],
      totalCents: { before: 9000, after: 12000 },
      date: { before: '2026-10-20', after: '2026-10-19' },
      netCents: { before: 4500, after: 6000 },
    })
    expect(told.get('bob')?.[0]).toMatchObject({
      changedBy: ['alice'],
      netCents: { before: -4500, after: -6000 },
    })
  })

  it('tells nobody about an edit undone within the window', () => {
    const rows = [
      edit(),
      edit({
        nets: { before: split(12000), after: split(9000) },
        totalCents: { before: 12000, after: 9000 },
      }),
    ]
    expect(transactionChanges(rows, current, samePerson).size).toBe(0)
  })

  it('tells nobody when nobody’s part, the total or the date changed', () => {
    // A note, a category or the receipts: their nets and the total stay.
    const row = edit({ nets: { before: split(9000), after: split(9000) }, totalCents: undefined })
    expect(transactionChanges([row], current, samePerson).size).toBe(0)
  })

  it('tells them when only their part changed', () => {
    // Bob now paid it all, so it's Alice who owes her half.
    const row = edit({ nets: { before: split(9000), after: split(-9000) }, totalCents: undefined })
    expect(transactionChanges([row], current, samePerson).get('alice')?.[0]?.netCents).toEqual({
      before: 4500,
      after: -4500,
    })
  })

  it('tells them when only the total changed', () => {
    // An item only Bob shares, which Bob paid: Alice's part stays.
    const row = edit({ nets: { before: split(9000), after: split(9000) } })
    expect(transactionChanges([row], current, samePerson).get('alice')?.[0]?.totalCents).toEqual({
      before: 9000,
      after: 12000,
    })
  })

  it('tells them when only the date changed', () => {
    const row = edit({
      nets: { before: split(9000), after: split(9000) },
      totalCents: undefined,
      date: { before: day('2026-10-20'), after: day('2026-10-21') },
    })
    expect(transactionChanges([row], current, samePerson).get('alice')?.[0]?.date).toEqual({
      before: '2026-10-20',
      after: '2026-10-21',
    })
  })

  it('tells everyone who was in a voided transaction, its total kept', () => {
    const voided = edit({
      actorPersonId: 'cara',
      voided: true,
      nets: { before: split(9000), after: [] },
      totalCents: undefined,
    })
    const told = transactionChanges([voided], current, samePerson)
    expect([...told.keys()]).toEqual(['alice', 'bob'])
    expect(told.get('bob')?.[0]).toMatchObject({
      voided: true,
      totalCents: { before: 9000, after: 9000 },
      netCents: { before: -4500, after: 0 },
    })
  })

  it('tells someone whose part was 0 that it was voided', () => {
    // Alice paid her own share, so her net was 0 before and after.
    const voided = edit({
      voided: true,
      nets: {
        before: [
          { personId: 'alice', netCents: 0 },
          { personId: 'bob', netCents: 0 },
        ],
        after: [],
      },
      totalCents: undefined,
    })
    expect(transactionChanges([voided], current, samePerson).get('alice')?.[0]).toMatchObject({
      voided: true,
      netCents: { before: 0, after: 0 },
    })
  })

  it('tells only who was in it when it was voided', () => {
    // Bob takes Cara, at 0, off it, then voids it in the same hour.
    const withCara = [...split(9000), { personId: 'cara', netCents: 0 }]
    const rows = [
      edit({ nets: { before: withCara, after: split(9000) }, totalCents: undefined }),
      edit({ voided: true, nets: { before: split(9000), after: [] }, totalCents: undefined }),
    ]
    const told = transactionChanges(rows, current, samePerson)
    expect([...told.keys()]).toEqual(['alice'])
    expect(told.get('alice')?.[0]).toMatchObject({ changedBy: ['bob'], voided: true })
  })

  it('tells someone taken off it before the void that their part went', () => {
    // Bob takes Cara, who owed $10.00, off it, then voids it in the same hour.
    const withCara = [
      { personId: 'alice', netCents: 5500 },
      { personId: 'bob', netCents: -4500 },
      { personId: 'cara', netCents: -1000 },
    ]
    const rows = [
      edit({ nets: { before: withCara, after: split(9000) }, totalCents: undefined }),
      edit({ voided: true, nets: { before: split(9000), after: [] }, totalCents: undefined }),
    ]
    expect(transactionChanges(rows, current, samePerson).get('cara')).toEqual([
      expect.objectContaining({
        changedBy: ['bob'],
        netCents: { before: -1000, after: 0 },
        voided: false,
      }),
    ])
  })

  it('doesn’t count who changed only what the email doesn’t show as having changed it', () => {
    // Bob changes the total. Then Alice edits the note and swaps Dan for Cara, both at 0: no
    // part changes.
    const dan = { personId: 'dan', netCents: 0 }
    const rows = [
      edit({ nets: { before: [...split(9000), dan], after: [...split(12000), dan] } }),
      edit({
        actorPersonId: 'alice',
        nets: {
          before: [...split(12000), dan],
          after: [...split(12000), { personId: 'cara', netCents: 0 }],
        },
        totalCents: undefined,
      }),
    ]
    // Bob hears nothing: the change he's told of would be only his own.
    const told = transactionChanges(rows, current, samePerson)
    expect([...told.keys()]).toEqual(['alice', 'dan', 'cara'])
    expect(told.get('alice')?.[0]?.changedBy).toEqual(['bob'])
  })

  it('counts who added people whose parts cancel out, though nobody else’s part changed', () => {
    // Dan paid $5.00 of the $90.00, for Cara's share: Alice paid $5.00 less, and her share is
    // $5.00 less, so her part stays.
    const row = edit({
      actorPersonId: 'alice',
      nets: {
        before: split(9000),
        after: [
          ...split(9000),
          { personId: 'cara', netCents: -500 },
          { personId: 'dan', netCents: 500 },
        ],
      },
      totalCents: undefined,
    })
    const told = transactionChanges([row], current, samePerson)
    expect([...told.keys()]).toEqual(['cara', 'dan'])
    expect(told.get('cara')?.[0]?.changedBy).toEqual(['alice'])
  })

  it('tells someone added or taken off it, from 0 or to 0', () => {
    const row = edit({
      actorPersonId: 'alice',
      nets: {
        before: split(9000),
        after: [
          { personId: 'alice', netCents: 6000 },
          { personId: 'cara', netCents: -6000 },
        ],
      },
    })
    const told = transactionChanges([row], current, samePerson)
    expect(told.get('bob')?.[0]?.netCents).toEqual({ before: -4500, after: 0 })
    expect(told.get('cara')?.[0]?.netCents).toEqual({ before: 0, after: -6000 })
  })

  it('follows merges for the people in it and for who changed it', () => {
    // P was merged into Bob: P's entries and Bob's are one person's.
    const personOf = (personId: string) => (personId === 'p' ? 'bob' : personId)
    const before = [
      { personId: 'alice', netCents: 4500 },
      { personId: 'bob', netCents: -3000 },
      { personId: 'p', netCents: -1500 },
    ]
    const byP = edit({ actorPersonId: 'p', nets: { before, after: split(12000) } })
    const toldByP = transactionChanges([byP], current, personOf)
    expect([...toldByP.keys()]).toEqual(['alice'])
    expect(toldByP.get('alice')?.[0]?.changedBy).toEqual(['bob'])
    const byAlice = edit({ actorPersonId: 'alice', nets: { before, after: split(12000) } })
    expect(transactionChanges([byAlice], current, personOf).get('bob')?.[0]?.netCents).toEqual({
      before: -4500,
      after: -6000,
    })
    // Bob changes the total, then Alice moves P's part onto Bob: still Bob's own part.
    const byBob = edit({
      nets: {
        before,
        after: [
          { personId: 'alice', netCents: 6000 },
          { personId: 'bob', netCents: -4500 },
          { personId: 'p', netCents: -1500 },
        ],
      },
    })
    const moved = edit({
      actorPersonId: 'alice',
      nets: { before: byBob.nets.after, after: split(12000) },
      totalCents: undefined,
    })
    expect(transactionChanges([byBob, moved], current, personOf).has('bob')).toBe(false)
    // Alice voids it with P's part in it: Bob was in it when it was voided.
    const voided = edit({
      actorPersonId: 'alice',
      voided: true,
      nets: { before, after: [] },
      totalCents: undefined,
    })
    expect(transactionChanges([voided], current, personOf).get('bob')?.[0]?.voided).toBe(true)
  })

  it('lists each person’s transactions, in the window’s order', () => {
    const rows = [edit({ transactionId: 't2' }), edit(), edit({ transactionId: 't2' })]
    const told = transactionChanges(rows, current, samePerson)
    expect(told.get('alice')?.map((change) => change.transactionId)).toEqual(['t2', 't1'])
  })
})
