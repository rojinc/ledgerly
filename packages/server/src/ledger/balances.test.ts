import type { Groups } from '@ledgerly/core/generated/rows'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { readGroupNets } from './balances'

const GROUP = { $id: 'g1', rev: 'r0' } as Groups

function share(id: string, personId: string, givenCents: number, receivedCents: number) {
  return { $id: id, transactionId: 't1', groupId: 'g1', personId, givenCents, receivedCents }
}

function db(revs: string[]) {
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
    expect(await readGroupNets(db(['r0']), GROUP)).toEqual([
      { personId: 'pA', netCents: 500 },
      { personId: 'pB', netCents: -500 },
    ])
  })

  it('reads again when a write committed in between, up to 3 times', async () => {
    const fake = db(['r1', 'r1'])
    expect(await readGroupNets(fake, GROUP)).toHaveLength(2)
    expect(fake.getRow).toHaveBeenCalledTimes(2)
  })

  it('reads again when a page’s cursor row was deleted meanwhile', async () => {
    const fake = db(['r0'])
    const list = fake.listRows.bind(fake)
    vi.spyOn(fake, 'listRows')
      .mockRejectedValueOnce(new AppwriteException('Cursor gone', 400, 'general_cursor_not_found'))
      .mockImplementation(list)
    expect(await readGroupNets(fake, GROUP)).toHaveLength(2)
    expect(fake.listRows).toHaveBeenCalledTimes(2)
  })

  it('throws any other read error', async () => {
    const fake = db(['r0'])
    vi.spyOn(fake, 'listRows').mockRejectedValue(
      new AppwriteException('Bad', 400, 'general_query_invalid'),
    )
    await expect(readGroupNets(fake, GROUP)).rejects.toMatchObject({
      type: 'general_query_invalid',
    })
  })

  it('gives CONFLICT after 3 torn reads', async () => {
    const fake = db(['r1', 'r2', 'r3', 'r4'])
    await expect(readGroupNets(fake, GROUP)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.getRow).toHaveBeenCalledTimes(3)
  })
})
