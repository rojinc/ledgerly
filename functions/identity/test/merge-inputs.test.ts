import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MERGE_BATCH } from '../src/merge'
import { moveInputs, VOID_REASON } from '../src/merge-inputs'
import { beforeStaging, NOW } from './harness'

// P (a placeholder) is merged into U; X is someone else.
const merge = { from: 'pP', into: 'pU' }
const FAR = Number.MAX_SAFE_INTEGER

function transaction(id: string, input: object, extra: object = {}) {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'expense',
    status: 'posted',
    statementId: null,
    date: '2026-10-01',
    description: 'Groceries',
    totalCents: 9000,
    inputJson: JSON.stringify(input),
    ...extra,
  }
}

const EXPENSE = {
  payers: [{ personId: 'pP', cents: 9000 }],
  split: { mode: 'equal', personIds: ['pP', 'pU', 'pX'] },
  note: 'Kept',
}

function seed(transactions: object[], more: Record<string, object[]> = {}) {
  return new FakeDb({
    groups: [{ $id: 'g1', type: 'house', name: 'Flat', rev: 'r0' }],
    transactions,
    ...more,
  } as ConstructorParameters<typeof FakeDb>[0])
}

function input(store: FakeDb, id: string) {
  return JSON.parse(store.rows('transactions').find((row) => row.$id === id)?.inputJson as string)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('moveInputs (step 3)', () => {
  it('renames P in the inputs and item splits of unlocked rows, and leaves the rest alone', async () => {
    const locked = transaction('t2', EXPENSE, { statementId: 'st1' })
    const voided = transaction('t3', EXPENSE, { status: 'void' })
    const without = transaction('t4', { split: { mode: 'equal', personIds: ['pU', 'pX'] } })
    const store = seed(
      [
        transaction('t1', EXPENSE),
        locked,
        voided,
        without,
        transaction('t5', {}, { status: 'scheduled' }),
      ],
      {
        items: [
          {
            $id: 'i1',
            transactionId: 't5',
            position: 0,
            name: 'Milk',
            quantity: 1,
            amountCents: 500,
            category: null,
            splitJson: JSON.stringify({ mode: 'equal', personIds: ['pP'] }),
          },
        ],
      },
    )
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toEqual({
      rewritten: 2,
      voided: 0,
      putOff: [],
      done: true,
    })
    expect(input(store, 't1')).toEqual({
      payers: [{ personId: 'pU', cents: 9000 }],
      split: {
        mode: 'weights',
        weights: [
          { personId: 'pU', weight: 2 },
          { personId: 'pX', weight: 1 },
        ],
      },
      note: 'Kept',
    })
    expect(JSON.parse(store.rows('items')[0]?.splitJson as string)).toEqual({
      mode: 'equal',
      personIds: ['pU'],
    })
    // A locked or void row keeps naming P, and a row without P isn't written.
    const stored = Object.fromEntries(store.rows('transactions').map((row) => [row.$id, row]))
    expect(stored.t2?.inputJson).toBe(locked.inputJson)
    expect(stored.t3?.inputJson).toBe(voided.inputJson)
    expect(stored.t4?.inputJson).toBe(without.inputJson)
    expect(store.rows('groups')[0]?.rev).not.toBe('r0')
    // Nothing names P any more: a second run writes nothing.
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({ rewritten: 0 })
  })

  it('voids a payment or loan whose two sides are now both U, as the ledger voids one', async () => {
    const store = seed(
      [
        transaction(
          't1',
          { payment: { fromPersonId: 'pP', toPersonId: 'pU' } },
          { kind: 'payment', description: 'Repaid' },
        ),
        transaction(
          't2',
          {
            payers: [{ personId: 'pU', cents: 9000 }],
            split: { mode: 'equal', personIds: ['pP'] },
          },
          { kind: 'loan', status: 'scheduled' },
        ),
      ],
      {
        shares: [
          { $id: 's1', transactionId: 't1', personId: 'pP', givenCents: 9000, receivedCents: 0 },
          { $id: 's2', transactionId: 't1', personId: 'pU', givenCents: 0, receivedCents: 9000 },
        ],
      },
    )
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({
      rewritten: 0,
      voided: 2,
    })
    expect(store.rows('transactions').map((row) => [row.$id, row.status, row.voidReason])).toEqual([
      ['t1', 'void', VOID_REASON],
      ['t2', 'void', VOID_REASON],
    ])
    expect(store.rows('shares')).toEqual([])
    expect(
      store.rows('activity').map((row) => [row.transactionId, row.action, row.actorPersonId]),
    ).toEqual([
      ['t1', 'transaction.voided', 'pU'],
      ['t2', 'transaction.voided', 'pU'],
    ])
  })

  it('puts off a group that has a statement being finalized, changing nothing', async () => {
    const store = seed([transaction('t1', EXPENSE)], {
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-09-01' }],
    })
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toEqual({
      rewritten: 0,
      voided: 0,
      putOff: ['g1'],
      done: false,
    })
    expect(input(store, 't1')).toEqual(EXPENSE)
    expect(store.rows('groups')[0]?.rev).toBe('r0')
  })

  it('reads a row again when it was edited after it was read, so the edit isn’t lost', async () => {
    const store = seed([transaction('t1', EXPENSE)])
    const edited = { ...EXPENSE, note: 'Edited meanwhile' }
    beforeStaging(
      store,
      (operations) => operations.includes('inputJson'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: 't1',
            data: { inputJson: JSON.stringify(edited) },
          }),
        ),
    )
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({ rewritten: 1 })
    expect(input(store, 't1')).toMatchObject({
      note: 'Edited meanwhile',
      payers: [{ personId: 'pU', cents: 9000 }],
    })
  })

  it('reads every page, and keeps each batch within 90 writes, a long receipt included', async () => {
    const rows = Array.from({ length: 120 }, (_, n) =>
      transaction(`t${String(n).padStart(3, '0')}`, EXPENSE),
    )
    const items = Array.from({ length: 200 }, (_, n) => ({
      $id: `i${String(n).padStart(3, '0')}`,
      transactionId: 't000',
      position: n,
      name: 'Item',
      quantity: 1,
      amountCents: 45,
      category: null,
      splitJson: JSON.stringify({ mode: 'equal', personIds: ['pP', 'pX'] }),
    }))
    const store = seed(rows, { items })
    const staged = vi.spyOn(store, 'createOperations')
    const result = await moveInputs(store, merge, ['g1'], NOW, FAR)
    expect(result.done).toBe(true)
    expect(store.rows('transactions').every((row) => !String(row.inputJson).includes('pP'))).toBe(
      true,
    )
    expect(store.rows('items').every((row) => !String(row.splitJson).includes('pP'))).toBe(true)
    const perTransaction = new Map<string, number>()
    for (const [params] of staged.mock.calls) {
      const count = perTransaction.get(params.transactionId) ?? 0
      perTransaction.set(params.transactionId, count + (params.operations?.length ?? 0))
    }
    for (const count of perTransaction.values()) expect(count).toBeLessThanOrEqual(MERGE_BATCH)
  })

  it('starts nothing once the deadline has passed, and says it isn’t done', async () => {
    const store = seed([transaction('t1', EXPENSE)])
    expect(await moveInputs(store, merge, ['g1'], NOW, 0)).toEqual({
      rewritten: 0,
      voided: 0,
      putOff: [],
      done: false,
    })
    expect(input(store, 't1')).toEqual(EXPENSE)
  })
})
