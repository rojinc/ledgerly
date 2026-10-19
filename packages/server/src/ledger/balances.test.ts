import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { balanceWrite, readBalances } from './balances'

const alice = { personId: 'alice', netCents: 3000, shares: 2 }
const bob = { personId: 'bob', netCents: -3000, shares: 1 }
// Bob pays Alice $30.
const payment = [
  { personId: 'bob', givenCents: 3000, receivedCents: 0 },
  { personId: 'alice', givenCents: 0, receivedCents: 3000 },
]

function db(peopleJson?: string) {
  return new FakeDb(peopleJson === undefined ? {} : { balances: [{ $id: 'g1', peopleJson }] })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readBalances', () => {
  it('reads the row, says when there is none, and null when it can’t be read', async () => {
    expect(await readBalances(db(JSON.stringify([alice, bob])), 'g1')).toEqual([alice, bob])
    expect(await readBalances(db(), 'g1')).toBeUndefined()
    expect(await readBalances(db('{'), 'g1')).toBeNull()
    expect(await readBalances(db(JSON.stringify([bob, alice])), 'g1')).toBeNull()
  })
})

describe('balanceWrite', () => {
  it('rewrites the row for the shares a write replaces', async () => {
    expect(await balanceWrite(db(JSON.stringify([alice, bob])), 'g1', [], payment)).toEqual([
      {
        action: 'update',
        tableId: 'balances',
        rowId: 'g1',
        data: {
          peopleJson: JSON.stringify([
            { personId: 'alice', netCents: 0, shares: 3 },
            { personId: 'bob', netCents: 0, shares: 2 },
          ]),
        },
      },
    ])
  })

  it('writes nothing for a group with no row yet, or when nothing changed', async () => {
    expect(await balanceWrite(db(), 'g1', [], payment)).toEqual([])
    expect(await balanceWrite(db(JSON.stringify([alice, bob])), 'g1', payment, payment)).toEqual([])
  })

  it('deletes a row that doesn’t fit the shares or can’t be read, and logs the group only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deleted = [{ action: 'delete', tableId: 'balances', rowId: 'g1' }]
    // Bob has 1 share in the row, so he can't lose 2.
    expect(
      await balanceWrite(db(JSON.stringify([alice, bob])), 'g1', [...payment, ...payment], []),
    ).toEqual(deleted)
    expect(await balanceWrite(db('not json'), 'g1', [], payment)).toEqual(deleted)
    expect(error.mock.calls).toEqual([
      ["balances: the row of group g1 doesn't fit its shares; deleted"],
      ["balances: the row of group g1 doesn't fit its shares; deleted"],
    ])
  })

  it('passes on a failed read', async () => {
    const broken = db()
    vi.spyOn(broken, 'getRow').mockRejectedValue(new Error('offline'))
    await expect(balanceWrite(broken, 'g1', [], payment)).rejects.toThrow('offline')
  })
})
