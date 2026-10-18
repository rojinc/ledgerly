import { describe, expect, it } from 'vitest'
import type { Net } from './nets'
import { suggestTransfers } from './suggest-transfers'

const nets = (entries: Record<string, number>): Net[] =>
  Object.entries(entries).map(([personId, netCents]) => ({ personId, netCents }))

describe('suggestTransfers', () => {
  it('has the debtors pay the creditor, ties by personId', () => {
    expect(suggestTransfers(nets({ alice: 6000, cara: -3000, bob: -3000 }))).toEqual([
      { fromPersonId: 'bob', toPersonId: 'alice', cents: 3000 },
      { fromPersonId: 'cara', toPersonId: 'alice', cents: 3000 },
    ])
  })

  it('picks the largest debtor and creditor again every round', () => {
    // Round 1: x pays a 100, leaving x owing 10. Round 2: y (50) is now the
    // largest debtor, so y pays b before x does.
    expect(suggestTransfers(nets({ a: 100, b: 60, x: -110, y: -50 }))).toEqual([
      { fromPersonId: 'x', toPersonId: 'a', cents: 100 },
      { fromPersonId: 'y', toPersonId: 'b', cents: 50 },
      { fromPersonId: 'x', toPersonId: 'b', cents: 10 },
    ])
  })

  it('returns nothing when everyone is square', () => {
    expect(suggestTransfers([])).toEqual([])
    expect(suggestTransfers(nets({ alice: 0, bob: 0 }))).toEqual([])
  })

  it('throws if the nets don’t add up to 0 or aren’t whole cents', () => {
    expect(() => suggestTransfers(nets({ alice: 100, bob: -99 }))).toThrow(RangeError)
    expect(() => suggestTransfers(nets({ alice: 0.5, bob: -0.5 }))).toThrow(RangeError)
  })

  // Seeded, so a failing case repeats on every run.
  function seededRandom(seed: number): () => number {
    let state = seed
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return state / 2_147_483_648
    }
  }

  it('always settles everyone, in at most n − 1 transfers, whatever the input order', () => {
    const random = seededRandom(15)
    for (let run = 0; run < 2000; run++) {
      const count = 1 + Math.floor(random() * 15)
      const amounts = Array.from({ length: count - 1 }, () =>
        Math.floor((random() - 0.5) * 2_000_000),
      )
      amounts.push(0 - amounts.reduce((sum, cents) => sum + cents, 0))
      const input = amounts.map((netCents, i) => ({ personId: `p${i}`, netCents }))

      const transfers = suggestTransfers(input)
      const balance = new Map(input.map((net) => [net.personId, net.netCents]))
      for (const { fromPersonId, toPersonId, cents } of transfers) {
        expect(cents).toBeGreaterThan(0)
        expect(balance.get(fromPersonId)).toBeLessThan(0)
        expect(balance.get(toPersonId)).toBeGreaterThan(0)
        balance.set(fromPersonId, (balance.get(fromPersonId) as number) + cents)
        balance.set(toPersonId, (balance.get(toPersonId) as number) - cents)
      }
      expect([...balance.values()].every((cents) => cents === 0)).toBe(true)
      const owing = input.filter((net) => net.netCents !== 0).length
      expect(transfers.length).toBeLessThanOrEqual(Math.max(owing - 1, 0))
      expect(suggestTransfers([...input].reverse())).toEqual(transfers)
    }
  })
})
