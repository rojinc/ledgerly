import type { Groups } from '@ledgerly/core/generated/rows'
import { AppwriteException } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { balanceWrite, readBalances, readGroupNets } from './balances'

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
    const deletedLine = { fn: 'unknown', event: 'balances_row_deleted', groupId: 'g1' }
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      deletedLine,
      deletedLine,
    ])
  })

  it('deletes a row whose net would pass a safe integer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const big = [{ personId: 'alice', netCents: Number.MAX_SAFE_INTEGER - 1, shares: 1 }]
    const share = [{ personId: 'alice', givenCents: 3000, receivedCents: 0 }]
    expect(await balanceWrite(db(JSON.stringify(big)), 'g1', [], share)).toEqual([
      { action: 'delete', tableId: 'balances', rowId: 'g1' },
    ])
  })

  it('passes on a failed read', async () => {
    const broken = db()
    vi.spyOn(broken, 'getRow').mockRejectedValue(new Error('offline'))
    await expect(balanceWrite(broken, 'g1', [], payment)).rejects.toThrow('offline')
  })
})

const GROUP = { $id: 'g1', rev: 'r0' } as Groups

function share(id: string, personId: string, givenCents: number, receivedCents: number) {
  return { $id: id, transactionId: 't1', groupId: 'g1', personId, givenCents, receivedCents }
}

function sharesDb(revs: string[]) {
  const fake = new FakeDb({
    groups: [{ $id: 'g1', rev: 'r0' }],
    shares: [share('s1', 'pA', 500, 0), share('s2', 'pB', 0, 500)],
  })
  // The group row as each read after the shares sees it.
  const reads = [...revs]
  vi.spyOn(fake, 'getRow').mockImplementation(
    async () => ({ $id: 'g1', rev: reads.shift() ?? revs.at(-1) }) as never,
  )
  return fake
}

describe('readGroupNets', () => {
  it('is each person’s net when the group didn’t change while it was read', async () => {
    expect(await readGroupNets(sharesDb(['r0']), GROUP)).toEqual([
      { personId: 'pA', netCents: 500 },
      { personId: 'pB', netCents: -500 },
    ])
  })

  it('reads again when a write committed in between, up to 3 times', async () => {
    const fake = sharesDb(['r1', 'r1'])
    expect(await readGroupNets(fake, GROUP)).toHaveLength(2)
    expect(fake.getRow).toHaveBeenCalledTimes(2)
  })

  it('reads again when a page’s cursor row was deleted meanwhile', async () => {
    const fake = sharesDb(['r0'])
    const list = fake.listRows.bind(fake)
    vi.spyOn(fake, 'listRows')
      .mockRejectedValueOnce(new AppwriteException('Cursor gone', 400, 'general_cursor_not_found'))
      .mockImplementation(list)
    expect(await readGroupNets(fake, GROUP)).toHaveLength(2)
    expect(fake.listRows).toHaveBeenCalledTimes(2)
  })

  it('throws any other read error', async () => {
    const fake = sharesDb(['r0'])
    vi.spyOn(fake, 'listRows').mockRejectedValue(
      new AppwriteException('Bad', 400, 'general_query_invalid'),
    )
    await expect(readGroupNets(fake, GROUP)).rejects.toMatchObject({
      type: 'general_query_invalid',
    })
  })

  it('gives CONFLICT after 3 torn reads', async () => {
    const fake = sharesDb(['r1', 'r2', 'r3', 'r4'])
    await expect(readGroupNets(fake, GROUP)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.getRow).toHaveBeenCalledTimes(3)
  })
})
