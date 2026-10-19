import { MAX_OPS_PER_DB_TRANSACTION as MERGE_BATCH } from '@ledgerly/core/constants/limits'
import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { buildShares } from '@ledgerly/core/ledger/build-shares'
import { netsFromShares } from '@ledgerly/core/settle/nets'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveInputs, moveTemplates, VOID_REASON } from '../src/merge-inputs'
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
      skipped: 0,
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

  it('never voids a loan whose borrowers come from the default split', async () => {
    // P lent 9 with no split, so everyone but P borrowed: U, and X and Y too.
    const store = seed([
      transaction('t1', { payers: [{ personId: 'pP', cents: 900 }] }, { kind: 'loan' }),
      transaction(
        't2',
        { payers: [{ personId: 'pP', cents: 5000 }] },
        { kind: 'loan', groupId: 'g1' },
      ),
    ])
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({
      rewritten: 2,
      voided: 0,
    })
    expect(store.rows('transactions').map((row) => row.status)).toEqual(['posted', 'posted'])
    expect(input(store, 't1')).toEqual({ payers: [{ personId: 'pU', cents: 900 }] })
  })

  it('writes out a default split P and U both had a part of, so an edit keeps every net', async () => {
    const share = (
      id: string,
      transactionId: string,
      personId: string,
      given: number,
      got: number,
    ) => ({
      $id: id,
      transactionId,
      personId,
      givenCents: given,
      receivedCents: got,
      groupId: 'g1',
      date: '2026-10-01',
      kind: 'expense',
      category: null,
    })
    const paid = { payers: [{ personId: 'pX', cents: 9000 }] }
    const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' }
    const store = seed(
      [
        // X paid $90 with no split: X, P and U had $30 each.
        transaction('t1', paid),
        // Only X and P had a part.
        transaction('t2', paid),
        // A bill for September, which this house splits by days when it names no split.
        transaction('t3', { ...paid, bill: period }, { kind: 'bill' }),
        // U lent $90 to P and X: once P is U, the default (everyone but the lender) would make X
        // owe it all, so the borrowers are written out, U in P's place.
        transaction('t4', { payers: [{ personId: 'pU', cents: 9000 }] }, { kind: 'loan' }),
        // An itemised receipt: each item has its own split.
        transaction('t5', paid),
      ],
      {
        groups: [
          {
            $id: 'g1',
            type: 'house',
            name: 'Flat',
            rev: 'r0',
            settingsJson: JSON.stringify({
              type: 'house',
              autoFinalize: false,
              defaultBillSplit: 'days',
            }),
          },
        ],
        shares: [
          share('s1', 't1', 'pX', 9000, 3000),
          share('s2', 't1', 'pP', 0, 3000),
          share('s3', 't1', 'pU', 0, 3000),
          share('s4', 't2', 'pX', 9000, 4500),
          share('s5', 't2', 'pP', 0, 4500),
          share('s6', 't3', 'pX', 9000, 3000),
          share('s7', 't3', 'pP', 0, 3000),
          share('s8', 't3', 'pU', 0, 3000),
          share('s9', 't4', 'pU', 9000, 0),
          share('s10', 't4', 'pP', 0, 4500),
          share('s11', 't4', 'pX', 0, 4500),
          share('s12', 't5', 'pX', 9000, 3000),
          share('s13', 't5', 'pP', 0, 3000),
          share('s14', 't5', 'pU', 0, 3000),
        ],
        items: [
          {
            $id: 'i1',
            transactionId: 't5',
            position: 0,
            name: 'Food',
            quantity: 1,
            amountCents: 9000,
            category: null,
            splitJson: JSON.stringify({ mode: 'equal', personIds: ['pP', 'pU', 'pX'] }),
          },
        ],
      },
    )
    await moveInputs(store, merge, ['g1'], NOW, FAR)
    expect(input(store, 't1')).toEqual({
      ...paid,
      split: {
        mode: 'weights',
        weights: [
          { personId: 'pU', weight: 2 },
          { personId: 'pX', weight: 1 },
        ],
      },
    })
    // U counts once in the default now, which is right where P alone had a part; a days split
    // lists U once anyway.
    expect(input(store, 't2')).toEqual(paid)
    expect(input(store, 't3')).toEqual({ ...paid, bill: period })
    expect(input(store, 't4')).toEqual({
      payers: [{ personId: 'pU', cents: 9000 }],
      split: { mode: 'equal', personIds: ['pU', 'pX'] },
    })
    expect(input(store, 't5')).toEqual(paid)

    // An edit plans the input again with the members as they are after the merge, X and U: every
    // net is the one the merged shares give (X +6000; P's −3000 and U's −3000 now U's).
    const after = {
      groupType: 'house' as const,
      ownerPersonId: 'pX',
      callerPersonId: 'pX',
      members: ['pU', 'pX'].map((personId) => ({
        personId,
        joinedOn: '2026-01-01' as LocalDate,
        leftOn: null,
      })),
    }
    const replan = (id: string, kind: 'expense' | 'loan') =>
      netsFromShares(
        buildShares({ ...input(store, id), kind, date: '2026-10-01', totalCents: 9000 }, after)
          .shares,
      )
    expect(replan('t1', 'expense')).toEqual([
      { personId: 'pU', netCents: -6000 },
      { personId: 'pX', netCents: 6000 },
    ])
    // U lent 9000, and P's 4500 was U's own: U is owed 4500, by X.
    expect(replan('t4', 'loan')).toEqual([
      { personId: 'pU', netCents: 4500 },
      { personId: 'pX', netCents: -4500 },
    ])
  })

  it('leaves a row it can’t rename as it is, says so by ID, and isn’t done', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // P's and U's weights would add up past MAX_WEIGHT; the other input isn't JSON.
    const heavy = transaction('t1', {
      payers: [{ personId: 'pX', cents: 9000 }],
      split: {
        mode: 'weights',
        weights: [
          { personId: 'pP', weight: 6000 },
          { personId: 'pU', weight: 6000 },
          { personId: 'pX', weight: 1 },
        ],
      },
    })
    const broken = { ...transaction('t2', {}), inputJson: '{' }
    const store = seed([heavy, broken, transaction('t3', EXPENSE)])
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toEqual({
      rewritten: 1,
      voided: 0,
      skipped: 2,
      putOff: [],
      done: false,
    })
    const stored = Object.fromEntries(store.rows('transactions').map((row) => [row.$id, row]))
    expect(stored.t1?.inputJson).toBe(heavy.inputJson)
    expect(stored.t2?.inputJson).toBe('{')
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      'merge pP into pU left transaction t1 as it is',
      'merge pP into pU left transaction t2 as it is',
    ])
  })

  it('keeps the stored input’s key order, and voids as the void route does', async () => {
    const stored = { note: 'First', split: { mode: 'equal', personIds: ['pP', 'pX'] } }
    const store = seed(
      [
        transaction('t1', stored),
        transaction(
          't2',
          { payment: { fromPersonId: 'pP', toPersonId: 'pU' } },
          { kind: 'payment' },
        ),
      ],
      { shares: [] },
    )
    await moveInputs(store, merge, ['g1'], NOW, FAR)
    expect(Object.keys(input(store, 't1'))).toEqual(['note', 'split'])
    expect(store.rows('transactions')[1]).toMatchObject({ status: 'void', updatedBy: 'pU' })
  })

  it('reads on past a voided row at the end of a page', async () => {
    // The 100th row of the first page is voided by the merge; the second page still reads.
    const rows = Array.from({ length: 101 }, (_, n) =>
      n === 99
        ? transaction(
            't099',
            { payment: { fromPersonId: 'pP', toPersonId: 'pU' } },
            { kind: 'payment' },
          )
        : transaction(`t${String(n).padStart(3, '0')}`, EXPENSE),
    )
    const store = seed(rows, { shares: [] })
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({
      rewritten: 100,
      voided: 1,
      done: true,
    })
  })

  it('puts off a group that has a statement being finalized, changing nothing', async () => {
    const store = seed([transaction('t1', EXPENSE)], {
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-09-01' }],
    })
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toEqual({
      rewritten: 0,
      voided: 0,
      skipped: 0,
      putOff: ['g1'],
      done: false,
    })
    expect(input(store, 't1')).toEqual(EXPENSE)
    expect(store.rows('groups')[0]?.rev).toBe('r0')
  })

  it('leaves a row a finalize locked after it was read (I-7)', async () => {
    const store = seed([transaction('t1', EXPENSE)])
    beforeStaging(
      store,
      (operations) => operations.includes('inputJson'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: 't1',
            data: { statementId: 'st1' },
          }),
        ),
    )
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({ rewritten: 0 })
    const [row] = store.rows('transactions')
    expect(row?.statementId).toBe('st1')
    expect(JSON.parse(row?.inputJson as string)).toEqual(EXPENSE)
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

  it('reads every page, and keeps each batch within 90 writes, a full receipt included', async () => {
    const rows = Array.from({ length: 120 }, (_, n) =>
      transaction(`t${String(n).padStart(3, '0')}`, EXPENSE),
    )
    const items = Array.from({ length: 30 }, (_, n) => ({
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
      skipped: 0,
      putOff: [],
      done: false,
    })
    expect(input(store, 't1')).toEqual(EXPENSE)
  })
})

describe('moveTemplates (step 3)', () => {
  function schedule(id: string, template: object, extra: object = {}) {
    return {
      $id: id,
      groupId: 'g1',
      kind: 'expense',
      description: 'Rent',
      templateJson: JSON.stringify(template),
      rrule: 'FREQ=MONTHLY',
      startsOn: '2026-01-01',
      endsOn: null,
      exdates: null,
      generatedThrough: '2026-11-30',
      nextRunAt: '2026-11-01T00:00:00.000Z',
      ...extra,
    }
  }

  function template(store: FakeDb, id: string) {
    return JSON.parse(store.rows('schedules').find((row) => row.$id === id)?.templateJson as string)
  }

  const RENT = {
    totalCents: 90000,
    payers: [{ personId: 'pU', cents: 90000 }],
    split: { mode: 'equal', personIds: ['pP', 'pU'] },
  }

  it('renames P in a template, and leaves one without P alone', async () => {
    const other = schedule('sc2', { split: { mode: 'equal', personIds: ['pU', 'pX'] } })
    const store = seed([], { schedules: [schedule('sc1', RENT), other] })
    expect(await moveTemplates(store, merge, ['g1'], FAR)).toEqual({
      rewritten: 1,
      skipped: 0,
      putOff: [],
      done: true,
    })
    expect(template(store, 'sc1').split).toEqual({
      mode: 'weights',
      weights: [{ personId: 'pU', weight: 2 }],
    })
    expect(store.rows('schedules')[1]?.templateJson).toBe(other.templateJson)
    expect(store.rows('groups')[0]?.rev).not.toBe('r0')
  })

  it('runs again when an expansion moved the schedule on after it was read', async () => {
    const store = seed([], { schedules: [schedule('sc1', RENT)] })
    const expansion = beforeStaging(
      store,
      (operations) => operations.includes('templateJson'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'schedules',
            rowId: 'sc1',
            data: { generatedThrough: '2026-12-31' },
          }),
        ),
    )
    expect(await moveTemplates(store, merge, ['g1'], FAR)).toMatchObject({ rewritten: 1 })
    expect(expansion).toHaveBeenCalled()
    const [stored] = store.rows('schedules')
    expect(stored?.generatedThrough).toBe('2026-12-31')
    expect(template(store, 'sc1').payers).toEqual([{ personId: 'pU', cents: 90000 }])
  })

  it('runs again on a template edited after it was read, so the edit isn’t lost', async () => {
    const store = seed([], { schedules: [schedule('sc1', RENT)] })
    // The rent goes up just before the merge stages its rewrite.
    const raised = { ...RENT, totalCents: 95000, payers: [{ personId: 'pU', cents: 95000 }] }
    beforeStaging(
      store,
      (operations) => operations.includes('templateJson'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'schedules',
            rowId: 'sc1',
            data: { templateJson: JSON.stringify(raised) },
          }),
        ),
    )
    expect(await moveTemplates(store, merge, ['g1'], FAR)).toMatchObject({ rewritten: 1 })
    expect(template(store, 'sc1')).toEqual({
      ...raised,
      split: { mode: 'weights', weights: [{ personId: 'pU', weight: 2 }] },
    })
  })

  it('puts off a group that is finalizing, and stops at the deadline', async () => {
    const finalizing = seed([], {
      schedules: [schedule('sc1', RENT)],
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-09-01' }],
    })
    expect(await moveTemplates(finalizing, merge, ['g1'], FAR)).toEqual({
      rewritten: 0,
      skipped: 0,
      putOff: ['g1'],
      done: false,
    })
    expect(template(finalizing, 'sc1')).toEqual(RENT)
    const late = seed([], { schedules: [schedule('sc1', RENT)] })
    expect(await moveTemplates(late, merge, ['g1'], 0)).toEqual({
      rewritten: 0,
      skipped: 0,
      putOff: [],
      done: false,
    })
  })
})
