import { MAX_OPS_PER_DB_TRANSACTION as MERGE_BATCH } from '@ledgerly/core/constants/limits'
import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { buildShares } from '@ledgerly/core/ledger/build-shares'
import { netsFromShares } from '@ledgerly/core/settle/nets'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveShares } from '../src/merge'
import { moveInputs, moveTemplates, VOID_REASON } from '../src/merge-inputs'
import { beforeStaging, NOW } from './harness'

// P (a placeholder) is merged into U; X is someone else.
const merge = { from: 'pP', into: 'pU' }
const FAR = Number.MAX_SAFE_INTEGER
const HOUSE = JSON.stringify({ type: 'house', autoFinalize: false, defaultBillSplit: 'days' })

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
    groups: [{ $id: 'g1', type: 'house', name: 'Flat', rev: 'r0', settingsJson: HOUSE }],
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
        balances: [{ $id: 'g1', peopleJson: '[]' }],
      },
    )
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toEqual({
      rewritten: 2,
      voided: 0,
      skipped: 0,
      putOff: [],
      cutOff: false,
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
    // A rewritten input changes no share, so the balances row stays.
    expect(store.rows('balances')).toHaveLength(1)
    // Nothing names P any more: a second run writes nothing.
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({ rewritten: 0 })
  })

  it('leaves an itemised row’s split to its items, posted or not', async () => {
    const store = seed([transaction('t1', { payers: [{ personId: 'pX', cents: 500 }] })], {
      items: [
        {
          $id: 'i1',
          transactionId: 't1',
          position: 0,
          name: 'Milk',
          quantity: 1,
          amountCents: 500,
          category: null,
          splitJson: JSON.stringify({ mode: 'equal', personIds: ['pP', 'pU'] }),
        },
      ],
      shares: [
        {
          $id: 's1',
          transactionId: 't1',
          groupId: 'g1',
          personId: 'pX',
          givenCents: 500,
          receivedCents: 0,
        },
        {
          $id: 's2',
          transactionId: 't1',
          groupId: 'g1',
          personId: 'pP',
          givenCents: 0,
          receivedCents: 250,
        },
        {
          $id: 's3',
          transactionId: 't1',
          groupId: 'g1',
          personId: 'pU',
          givenCents: 0,
          receivedCents: 250,
        },
      ],
      members: ['pU', 'pX'].map((personId) => ({
        $id: `m${personId}`,
        groupId: 'g1',
        personId,
        status: 'active',
        joinedOn: '2026-01-01',
        leftOn: null,
      })),
    })
    await moveInputs(store, merge, ['g1'], NOW, FAR)
    expect(input(store, 't1')).toEqual({ payers: [{ personId: 'pX', cents: 500 }] })
    expect(JSON.parse(store.rows('items')[0]?.splitJson as string)).toEqual({
      mode: 'weights',
      weights: [{ personId: 'pU', weight: 2 }],
    })
  })

  it('writes out an item split the merge would change, so an edit after it keeps every net', async () => {
    // X paid 1.00 of milk, split equally by A, P and U: A 34, P 33, U 33.
    const store = seed(
      [transaction('t1', { payers: [{ personId: 'pX', cents: 100 }] }, { totalCents: 100 })],
      {
        items: [
          {
            $id: 'i1',
            transactionId: 't1',
            position: 0,
            name: 'Milk',
            quantity: 1,
            amountCents: 100,
            category: null,
            splitJson: JSON.stringify({ mode: 'equal', personIds: ['pA', 'pP', 'pU'] }),
          },
        ],
        shares: [
          {
            $id: 's1',
            transactionId: 't1',
            groupId: 'g1',
            personId: 'pX',
            givenCents: 100,
            receivedCents: 0,
          },
          {
            $id: 's2',
            transactionId: 't1',
            groupId: 'g1',
            personId: 'pA',
            givenCents: 0,
            receivedCents: 34,
          },
          {
            $id: 's3',
            transactionId: 't1',
            groupId: 'g1',
            personId: 'pP',
            givenCents: 0,
            receivedCents: 33,
          },
          {
            $id: 's4',
            transactionId: 't1',
            groupId: 'g1',
            personId: 'pU',
            givenCents: 0,
            receivedCents: 33,
          },
        ],
        members: ['pA', 'pU', 'pX'].map((personId) => ({
          $id: `m${personId}`,
          groupId: 'g1',
          personId,
          status: 'active',
          joinedOn: '2026-01-01',
          leftOn: null,
        })),
      },
    )
    await moveInputs(store, merge, ['g1'], NOW, FAR)
    await moveShares(store, 'pP', 'pU', ['g1'], FAR)
    // As weights A 1, U 2, A would get 33.
    const split = JSON.parse(store.rows('items')[0]?.splitJson as string)
    expect(split).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'pA', cents: 34 },
        { personId: 'pU', cents: 66 },
      ],
    })
    const members = ['pA', 'pU', 'pX'].map((personId) => ({
      personId,
      joinedOn: '2026-01-01' as LocalDate,
      leftOn: null,
    }))
    const replanned = buildShares(
      {
        ...input(store, 't1'),
        kind: 'expense',
        date: '2026-10-01' as LocalDate,
        items: [{ name: 'Milk', amountCents: 100, split }],
      },
      { groupType: 'house', ownerPersonId: 'pX', callerPersonId: 'pX', members },
    ).shares
    expect(netsFromShares(replanned)).toEqual(netsFromShares(store.rows('shares') as never))
  })

  it('plans a days item as the members were before the merge, from step 1’s record (B2)', async () => {
    // X paid a September bill of 75.00, one item split by days: P was there all 30 days, U 15
    // (from the 16th), X 30, so P 30.00, U 15.00, X 30.00. After step 2, U's kept row starts
    // when P's did, so an edit would give U only 37.50.
    const september = { periodStart: '2026-09-01', periodEnd: '2026-09-30' }
    const bill = transaction(
      't1',
      { payers: [{ personId: 'pX', cents: 7500 }], bill: september },
      { kind: 'bill', totalCents: 7500 },
    )
    const share = (id: string, personId: string, given: number, received: number) => ({
      $id: id,
      transactionId: 't1',
      groupId: 'g1',
      personId,
      givenCents: given,
      receivedCents: received,
    })
    const store = seed([bill], {
      items: [
        {
          $id: 'i1',
          transactionId: 't1',
          position: 0,
          name: 'Power',
          quantity: 1,
          amountCents: 7500,
          category: null,
          splitJson: JSON.stringify({ mode: 'days', personIds: ['pP', 'pU', 'pX'] }),
        },
      ],
      shares: [
        share('s1', 'pX', 7500, 3000),
        share('s2', 'pP', 0, 3000),
        share('s3', 'pU', 0, 1500),
      ],
      members: ['pU', 'pX'].map((personId) => ({
        $id: `m${personId}`,
        groupId: 'g1',
        personId,
        status: 'active',
        joinedOn: '2026-01-01',
        leftOn: null,
      })),
    })
    const recorded = [
      {
        groupId: 'g1',
        from: { joinedOn: '2026-01-01' as LocalDate, leftOn: null },
        into: { joinedOn: '2026-09-16' as LocalDate, leftOn: null },
      },
    ]
    await moveInputs(store, merge, ['g1'], NOW, FAR, recorded)
    expect(JSON.parse(store.rows('items')[0]?.splitJson as string)).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'pU', cents: 4500 },
        { personId: 'pX', cents: 3000 },
      ],
    })
    // With no record, the item can't be planned as it was, so it's renamed only.
    const unrecorded = seed([bill], {
      items: store.rows('items').map((item) => ({
        ...item,
        splitJson: JSON.stringify({ mode: 'days', personIds: ['pP', 'pU', 'pX'] }),
      })),
      members: ['pU', 'pX'].map((personId) => ({
        $id: `m${personId}`,
        groupId: 'g1',
        personId,
        status: 'active',
        joinedOn: '2026-01-01',
        leftOn: null,
      })),
    })
    await moveInputs(unrecorded, merge, ['g1'], NOW, FAR)
    expect(JSON.parse(unrecorded.rows('items')[0]?.splitJson as string)).toEqual({
      mode: 'days',
      personIds: ['pU', 'pX'],
    })
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
        balances: [{ $id: 'g1', peopleJson: '[]' }],
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
    // A void deletes shares, so the batch deletes the balances row too.
    expect(store.rows('balances')).toEqual([])
    expect(
      store.rows('activity').map((row) => [row.transactionId, row.action, row.actorPersonId]),
    ).toEqual([
      ['t1', 'transaction.voided', 'pU'],
      ['t2', 'transaction.voided', 'pU'],
    ])
  })

  it('voids a posted loan with no stored payers only where U posted it, so lent it', async () => {
    const toP = (id: string, createdBy: string) => transaction(id, {}, { kind: 'loan', createdBy })
    const store = seed([toP('t1', 'pU'), toP('t2', 'pX')], {
      shares: ['t1', 't2'].flatMap((transactionId) => [
        {
          $id: `${transactionId}p`,
          transactionId,
          personId: 'pP',
          givenCents: 0,
          receivedCents: 9000,
        },
      ]),
      members: ['pU', 'pX'].map((personId) => ({
        $id: `m${personId}`,
        groupId: 'g1',
        personId,
        status: 'active',
        joinedOn: '2026-01-01',
        leftOn: null,
      })),
    })
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({
      rewritten: 0,
      voided: 1,
    })
    expect(store.rows('transactions').map((row) => [row.$id, row.status])).toEqual([
      ['t1', 'void'],
      ['t2', 'posted'],
    ])
    // X lent it to P: its default, X's one borrower, is U now, so it stays as it was.
    expect(input(store, 't2')).toEqual({})
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

  it('writes out a split the merge would change, so an edit after it keeps every net', async () => {
    const share = (transactionId: string, personId: string, given: number, got: number) => ({
      $id: `s-${transactionId}-${personId}`,
      transactionId,
      personId,
      givenCents: given,
      receivedCents: got,
      groupId: 'g1',
      date: '2026-10-01',
      kind: 'expense',
      category: null,
    })
    // X paid $90 for each row but t4, and each person's part is the shares' received.
    const paidByX = (transactionId: string, parts: [string, number][]) => [
      share(transactionId, 'pX', 9000, parts.find(([id]) => id === 'pX')?.[1] ?? 0),
      ...parts.filter(([id]) => id !== 'pX').map(([id, got]) => share(transactionId, id, 0, got)),
    ]
    const paid = { payers: [{ personId: 'pX', cents: 9000 }] }
    const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' }
    const thirds: [string, number][] = [
      ['pP', 3000],
      ['pU', 3000],
      ['pX', 3000],
    ]
    const byDays: [string, number][] = [
      ['pP', 2000],
      ['pU', 3000],
      ['pX', 4000],
    ]
    const rows: [string, string, object, object[]][] = [
      // The default split, with P and U both in it.
      ['t1', 'expense', paid, paidByX('t1', thirds)],
      // The default split, with P alone: U counts once, which is right.
      [
        't2',
        'expense',
        paid,
        paidByX('t2', [
          ['pP', 4500],
          ['pX', 4500],
        ]),
      ],
      // A September bill this house splits by days when it names no split.
      ['t3', 'bill', { ...paid, bill: period }, paidByX('t3', thirds)],
      // U lent $90 to P and X, with no split.
      [
        't4',
        'loan',
        { payers: [{ personId: 'pU', cents: 9000 }] },
        [share('t4', 'pU', 9000, 0), share('t4', 'pP', 0, 4500), share('t4', 'pX', 0, 4500)],
      ],
      [
        't6',
        'expense',
        { ...paid, split: { mode: 'equal', personIds: ['pP', 'pU', 'pX'] } },
        paidByX('t6', thirds),
      ],
      [
        't7',
        'expense',
        {
          ...paid,
          split: {
            mode: 'weights',
            weights: [
              { personId: 'pP', weight: 1 },
              { personId: 'pU', weight: 2 },
              { personId: 'pX', weight: 3 },
            ],
          },
        },
        paidByX('t7', [
          ['pP', 1500],
          ['pU', 3000],
          ['pX', 4500],
        ]),
      ],
      [
        't8',
        'expense',
        {
          ...paid,
          split: {
            mode: 'exact',
            amounts: byDays.map(([personId, cents]) => ({ personId, cents })),
          },
        },
        paidByX('t8', byDays),
      ],
      [
        't9',
        'expense',
        {
          ...paid,
          split: {
            mode: 'percent',
            percents: [
              { personId: 'pP', basisPoints: 2500 },
              { personId: 'pU', basisPoints: 2500 },
              { personId: 'pX', basisPoints: 5000 },
            ],
          },
        },
        paidByX('t9', [
          ['pP', 2250],
          ['pU', 2250],
          ['pX', 4500],
        ]),
      ],
      [
        't10',
        'bill',
        { ...paid, bill: period, split: { mode: 'days', personIds: ['pP', 'pU', 'pX'] } },
        paidByX('t10', byDays),
      ],
      // U came on 16 September, but U's kept row now starts when P's did, in January.
      [
        't11',
        'bill',
        { ...paid, bill: period },
        paidByX('t11', [
          ['pU', 3000],
          ['pX', 6000],
        ]),
      ],
    ]
    // The members as step 2 leaves them: P's row is gone, and U's starts at the earlier date.
    const members = ['pU', 'pX'].map((personId) => ({
      personId,
      joinedOn: '2026-01-01' as LocalDate,
      leftOn: null,
    }))
    const store = seed(
      rows.map(([id, kind, input]) => transaction(id, input, { kind })),
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
        shares: rows.flatMap(([, , , shares]) => shares),
        members: members.map((member) => ({
          $id: `m${member.personId}`,
          groupId: 'g1',
          status: 'active',
          ...member,
        })),
      },
    )
    await moveInputs(store, merge, ['g1'], NOW, FAR)
    await moveShares(store, 'pP', 'pU', ['g1'], FAR)

    // What each split became.
    expect(input(store, 't1').split).toEqual({
      mode: 'weights',
      weights: [
        { personId: 'pU', weight: 2 },
        { personId: 'pX', weight: 1 },
      ],
    })
    expect(input(store, 't2').split).toBeUndefined()
    // By days, P and U had a third each: weights plan that again.
    expect(input(store, 't3').split).toEqual(input(store, 't1').split)
    expect(input(store, 't4').split).toEqual({ mode: 'equal', personIds: ['pU', 'pX'] })
    expect(input(store, 't10').split).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'pU', cents: 5000 },
        { personId: 'pX', cents: 4000 },
      ],
    })
    // Not P's (no part, and not named), so left as it is, though U's kept row has changed what an
    // edit would plan (lead, #242: only rows that name P or that P has a share in).
    expect(input(store, 't11').split).toBeUndefined()

    // An edit plans each row again with the members as they are after the merge, X and U: every
    // net is the one its merged shares give.
    const after = {
      groupType: 'house' as const,
      ownerPersonId: 'pX',
      callerPersonId: 'pX',
      members,
    }
    for (const [id, kind] of rows.filter(([id]) => id !== 't11')) {
      const replanned = buildShares(
        { ...input(store, id), kind: kind as 'expense', date: '2026-10-01', totalCents: 9000 },
        after,
      ).shares
      const stored = store.rows('shares').filter((row) => row.transactionId === id) as never
      expect([id, netsFromShares(replanned)]).toEqual([id, netsFromShares(stored)])
    }
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
      cutOff: false,
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
      cutOff: false,
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

  it('plans a row again with the members as they are when a member change made it run again', async () => {
    // P paid 90 for U and X, the default way (P had joined later). After step 2, the default
    // still gives U and X 45 each, so only P would be renamed. But meanwhile X's move-out date
    // is set to before the row's date, and the row is edited, so the batch runs again: now the
    // default would give U all 90, so the split is written out.
    const paidByP = transaction('t1', { payers: [{ personId: 'pP', cents: 9000 }] })
    const store = seed([paidByP], {
      members: ['pU', 'pX'].map((personId) => ({
        $id: `m${personId}`,
        groupId: 'g1',
        personId,
        status: 'active',
        joinedOn: '2026-01-01',
        leftOn: null,
      })),
      shares: [
        {
          $id: 's1',
          transactionId: 't1',
          groupId: 'g1',
          personId: 'pP',
          givenCents: 9000,
          receivedCents: 0,
          date: '2026-10-01',
          kind: 'expense',
          category: null,
        },
        {
          $id: 's2',
          transactionId: 't1',
          groupId: 'g1',
          personId: 'pU',
          givenCents: 0,
          receivedCents: 4500,
          date: '2026-10-01',
          kind: 'expense',
          category: null,
        },
        {
          $id: 's3',
          transactionId: 't1',
          groupId: 'g1',
          personId: 'pX',
          givenCents: 0,
          receivedCents: 4500,
          date: '2026-10-01',
          kind: 'expense',
          category: null,
        },
      ],
    })
    beforeStaging(
      store,
      (operations) => operations.includes('inputJson'),
      () =>
        withTransaction(store, (tx) =>
          tx.write(
            { action: 'update', tableId: 'members', rowId: 'mpX', data: { leftOn: '2026-09-15' } },
            {
              action: 'update',
              tableId: 'transactions',
              rowId: 't1',
              data: {
                inputJson: JSON.stringify({
                  payers: [{ personId: 'pP', cents: 9000 }],
                  note: 'Shop',
                }),
              },
            },
          ),
        ),
    )
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({ rewritten: 1 })
    expect(input(store, 't1')).toEqual({
      payers: [{ personId: 'pU', cents: 9000 }],
      note: 'Shop',
      split: { mode: 'equal', personIds: ['pU', 'pX'] },
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

  it('keeps a batch with a void and the balances row delete within 90 writes', async () => {
    // t000, P paying U back, is voided: its update, two share deletes and an activity row. The
    // 86 renames after it take one write each.
    const rows = [
      transaction(
        't000',
        { payment: { fromPersonId: 'pP', toPersonId: 'pU' } },
        { kind: 'payment' },
      ),
      ...Array.from({ length: 86 }, (_, n) =>
        transaction(`t${String(n + 1).padStart(3, '0')}`, EXPENSE),
      ),
    ]
    const store = seed(rows, {
      shares: [
        { $id: 's1', transactionId: 't000', personId: 'pP', givenCents: 9000, receivedCents: 0 },
        { $id: 's2', transactionId: 't000', personId: 'pU', givenCents: 0, receivedCents: 9000 },
      ],
      balances: [{ $id: 'g1', peopleJson: '[]' }],
    })
    const staged = vi.spyOn(store, 'createOperations')
    expect(await moveInputs(store, merge, ['g1'], NOW, FAR)).toMatchObject({
      rewritten: 86,
      voided: 1,
      done: true,
    })
    const perTransaction = new Map<string, number>()
    for (const [params] of staged.mock.calls) {
      const count = perTransaction.get(params.transactionId) ?? 0
      perTransaction.set(params.transactionId, count + (params.operations?.length ?? 0))
    }
    // The first: the guard, the delete, the void's 4 and 84 renames.
    expect([...perTransaction.values()]).toEqual([MERGE_BATCH, 3])
    expect(store.rows('balances')).toEqual([])
  })

  it('starts nothing once the deadline has passed, and says it isn’t done', async () => {
    const store = seed([transaction('t1', EXPENSE)])
    expect(await moveInputs(store, merge, ['g1'], NOW, 0)).toEqual({
      rewritten: 0,
      voided: 0,
      skipped: 0,
      putOff: [],
      cutOff: true,
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
      cutOff: false,
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
      cutOff: false,
      done: false,
    })
    expect(template(finalizing, 'sc1')).toEqual(RENT)
    const late = seed([], { schedules: [schedule('sc1', RENT)] })
    expect(await moveTemplates(late, merge, ['g1'], 0)).toEqual({
      rewritten: 0,
      skipped: 0,
      putOff: [],
      cutOff: true,
      done: false,
    })
  })
})
