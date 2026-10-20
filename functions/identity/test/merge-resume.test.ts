import type { Persons } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markMergesToResume } from '../src/join-group'
import { clearResume } from '../src/run-merge'
import {
  account,
  BEFORE,
  beforeCommit,
  call,
  type Fakes,
  fakes,
  NOW,
  ok,
  placeholderRow,
  updateRow,
} from './harness'

// A group the merge skipped, joined later (identity-and-invites.md#finishing-merges, #358). Sam
// (pSam, u1) signed up on 10 October. Sammy (pP), a placeholder, was merged into Sam, and that
// merge finished, with no identity left, but skipped g1: Sammy's row there was removed before
// step 2, and Sam wasn't joined there. So g1's activity still names Sammy.
const CLAIMED_AT = '2026-10-10T00:00:00.000Z'
// After Sam signed up: no claim joins a row added then (D-016), only a join from the app does.
const ADDED = '2026-10-15T00:00:00.000Z'
const SAM = {
  $id: 'pSam',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: CLAIMED_AT,
  mergedInto: null,
  deletedAt: null,
}
const SAMMY = {
  $id: 'pP',
  userId: null,
  displayName: 'Sammy',
  claimedAt: null,
  mergedInto: 'pSam',
  deletedAt: null,
  mergeGroupIds: ['g1'],
  mergeMembersJson: JSON.stringify([
    { groupId: 'g1', from: { joinedOn: '2026-01-01', leftOn: null }, into: null },
  ]),
}
const GROUP = {
  $id: 'g1',
  type: 'house',
  name: 'Flat',
  ownerPersonId: 'pAdmin',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  statementCycle: 'none',
  cycleAnchor: null,
  nextCloseAt: null,
  archivedAt: null,
  rev: 'r0',
  settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"equal"}',
}
// "Added Sammy", written while Sammy was a placeholder.
const ABOUT_SAMMY = {
  $id: 'a1',
  groupId: 'g1',
  actorPersonId: 'pAdmin',
  action: 'member.added',
  subjectPersonId: 'pP',
  summary: 'added',
  at: BEFORE,
}

// Next month's rent, not posted yet, still naming Sammy as a payer and a sharer.
const RENT = {
  $id: 't1',
  groupId: 'g1',
  kind: 'expense',
  status: 'scheduled',
  statementId: null,
  date: '2026-11-01',
  description: 'Rent',
  totalCents: 9000,
  inputJson: JSON.stringify({
    payers: [{ personId: 'pP', cents: 9000 }],
    split: { mode: 'equal', personIds: ['pP', 'pX'] },
  }),
}

type Row = Record<string, unknown> & { $id: string }

function seeded(
  more: {
    persons?: Row[]
    identities?: Row[]
    members?: Row[]
    activity?: Row[]
    transactions?: Row[]
    statements?: Row[]
  } = {},
  samsRow: Row | null = placeholderRow('mSam', 'g1', 'pSam', ADDED, { displayName: 'Sam' }),
): Fakes {
  const services = fakes(
    {
      persons: [SAM, SAMMY, ...(more.persons ?? [])],
      identities: more.identities ?? [],
      groups: [GROUP],
      members: [...(samsRow ? [samsRow] : []), ...(more.members ?? [])],
      activity: [ABOUT_SAMMY, ...(more.activity ?? [])],
      transactions: more.transactions ?? [],
      statements: more.statements ?? [],
    } as Parameters<typeof fakes>[0],
    { teams: { g1: ['uAdmin'] } },
  )
  services.users.get = async () => account()
  return services
}

/** A scheduled run, as Appwrite sends it: no JWT, the `schedule` trigger. */
async function hourly(services: Fakes) {
  const { body } = await call(services, 'POST', '/', undefined, null, {
    'x-appwrite-trigger': 'schedule',
  })
  return body
}

function personOf(services: Fakes, id: string) {
  return services.db.rows('persons').find((row) => row.$id === id) as Persons | undefined
}

function namedIn(services: Fakes, transactionId: string): string[] {
  const row = services.db.rows('transactions').find((found) => found.$id === transactionId)
  const input = JSON.parse(String(row?.inputJson))
  return [input.payers[0].personId, ...input.split.personIds]
}

function subjectOf(services: Fakes, activityId: string) {
  return services.db.rows('activity').find((row) => row.$id === activityId)?.subjectPersonId
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {})
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('a later join carries a merge on in that group (#358)', () => {
  it('marks a finished merge when U joins from the app, and the hourly run renames P there', async () => {
    const services = seeded({ transactions: [RENT] })
    await ok(services, 'POST', '/groups/g1/join')
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(NOW.toISOString())
    // Only marked: a join from the app doesn't carry merges on (the lead's Q2).
    expect(subjectOf(services, 'a1')).toBe('pP')
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 1, finished: 1 } })
    expect(subjectOf(services, 'a1')).toBe('pSam')
    // The unposted row's input names Sam now, so g1 is no longer open: an edit of it can plan.
    expect(namedIn(services, 't1')).toEqual(['pSam', 'pSam', 'pX'])
    expect(personOf(services, 'pP')?.mergeResumeAt).toBeNull()
    // Nothing left: the next run finds no merge.
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 0 } })
  })

  it('marks it when a claim joins U’s own row, and the claim carries it on there at once', async () => {
    // Sam's row predates the claim, so Claim step 3 joins it: the gap where the hourly run
    // finished the merge before Sam's claim joined g1 (AI C's second note).
    const services = seeded(
      {
        identities: [
          {
            $id: 'iEmail',
            key: 'email:sam@example.com',
            type: 'email',
            personId: 'pSam',
            verified: true,
            verifiedAt: CLAIMED_AT,
          },
        ],
      },
      placeholderRow('mSam', 'g1', 'pSam', BEFORE, { displayName: 'Sam' }),
    )
    const { linkedGroupIds } = await ok<{ linkedGroupIds: string[] }>(services, 'POST', '/claim')
    expect(linkedGroupIds).toEqual(['g1'])
    expect(subjectOf(services, 'a1')).toBe('pSam')
    expect(personOf(services, 'pP')?.mergeResumeAt).toBeNull()
  })

  it('marks it when U, re-added after leaving on their own, joins again (AI C’s third case)', async () => {
    // Step 2 gave Sammy's row to Sam (the merge's member.joined), Sam then left g1 on their own
    // before the merge renamed Sammy's rent there, and an admin removed that row and added Sam
    // again.
    const services = seeded({
      transactions: [RENT],
      activity: [
        {
          $id: 'a0',
          groupId: 'g1',
          actorPersonId: 'pSam',
          action: 'member.joined',
          subjectPersonId: 'pSam',
          summary: 'joined',
          at: '2026-10-11T00:00:00.000Z',
        },
        {
          $id: 'a2',
          groupId: 'g1',
          actorPersonId: 'pSam',
          action: 'member.left',
          subjectPersonId: 'pSam',
          summary: 'left',
          at: '2026-10-12T00:00:00.000Z',
        },
      ],
    })
    await ok(services, 'POST', '/groups/g1/join')
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(NOW.toISOString())
    expect(await hourly(services)).toMatchObject({ ok: true, data: { finished: 1 } })
    expect(subjectOf(services, 'a1')).toBe('pSam')
    expect(namedIn(services, 't1')).toEqual(['pSam', 'pSam', 'pX'])
  })

  it('marks the other merges into U when merge step 2 itself joins U to the group', async () => {
    // Two merges into Sam, both unfinished. pA's row in g1 was removed before step 2, so pA skips
    // g1 and finishes first ($id order). Then pB's step 2 gives pB's row in g1 to Sam, joining
    // Sam there: pA is marked, and Sammy too (also merged into Sam, listing g1), and the next run
    // renames them there (the lead's fix 1).
    const services = seeded(
      {
        persons: [
          { ...SAMMY, $id: 'pA' },
          { ...SAMMY, $id: 'pB' },
        ],
        identities: [
          { $id: 'iA', key: 'email:a@example.com', type: 'email', personId: 'pA', verified: true },
          { $id: 'iB', key: 'email:b@example.com', type: 'email', personId: 'pB', verified: true },
        ],
        members: [placeholderRow('mB', 'g1', 'pB', BEFORE)],
        activity: [{ ...ABOUT_SAMMY, $id: 'aA', subjectPersonId: 'pA' }],
      },
      null,
    )
    expect(await hourly(services)).toMatchObject({ ok: true, data: { finished: 2 } })
    for (const id of ['pA', 'pP']) {
      expect(personOf(services, id)?.mergeResumeAt).toBe(NOW.toISOString())
    }
    // pB's own merge isn't marked by its own step 2.
    expect(personOf(services, 'pB')?.mergeResumeAt ?? null).toBeNull()
    expect(subjectOf(services, 'aA')).toBe('pA')
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 2, finished: 2 } })
    expect([subjectOf(services, 'aA'), subjectOf(services, 'a1')]).toEqual(['pSam', 'pSam'])
    for (const id of ['pA', 'pP']) expect(personOf(services, id)?.mergeResumeAt).toBeNull()
  })

  it('marks only the placeholders whose merges list the group joined', async () => {
    // Pat was merged into Sam too, but was never in g1. Finishing skips Del (deleted) and Una (with
    // an account), so a mark on them would never be cleared.
    const services = seeded({
      persons: [
        { ...SAMMY, $id: 'pPat', mergeGroupIds: ['g9'] },
        { ...SAMMY, $id: 'pDel', deletedAt: BEFORE },
        { ...SAMMY, $id: 'pUna', userId: 'u9' },
      ],
    })
    await ok(services, 'POST', '/groups/g1/join')
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(NOW.toISOString())
    for (const id of ['pPat', 'pDel', 'pUna']) {
      expect(personOf(services, id)?.mergeResumeAt ?? null).toBeNull()
    }
  })

  it('keeps the merge unfinished when a join marks it again while the run clears it', async () => {
    const services = seeded()
    await ok(services, 'POST', '/groups/g1/join')
    const later = new Date(NOW.getTime() + 60_000).toISOString()
    // The run's clear stages, then reads P: a second join's mark commits just before that read.
    const getRow = services.db.getRow.bind(services.db)
    let marked = false
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      if (
        !marked &&
        params.tableId === 'persons' &&
        params.rowId === 'pP' &&
        subjectOf(services, 'a1') === 'pSam'
      ) {
        marked = true
        await updateRow(services.db, 'persons', 'pP', { mergeResumeAt: later })
      }
      return getRow(params)
    })
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 1, finished: 0 } })
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(later)
    vi.mocked(services.db.getRow).mockRestore()
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 1, finished: 1 } })
    expect(personOf(services, 'pP')?.mergeResumeAt).toBeNull()
  })

  it('keeps the mark while the carry-on is put off, and clears it once the group is done', async () => {
    // A statement in g1 is being finalized: step 3 waits there, so the merge isn't finished.
    const services = seeded({
      transactions: [RENT],
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-10-01' }],
    })
    await ok(services, 'POST', '/groups/g1/join')
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 1, finished: 0 } })
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(NOW.toISOString())
    expect(namedIn(services, 't1')).toEqual(['pP', 'pP', 'pX'])
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'statements',
        rowId: 'st1',
        data: { status: 'final' },
      }),
    )
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 1, finished: 1 } })
    expect(namedIn(services, 't1')).toEqual(['pSam', 'pSam', 'pX'])
    expect(personOf(services, 'pP')?.mergeResumeAt).toBeNull()
  })

  it('counts a merge marked during the run, after its read, as not finished yet', async () => {
    // pA's step 2 joins Sam to g1 and marks pB, read before that without a mark. pB's merge still
    // renames g1 in this run, but keeps the mark for the next one, which finds nothing left.
    const services = seeded(
      {
        persons: [
          { ...SAMMY, $id: 'pA' },
          { ...SAMMY, $id: 'pB' },
        ],
        identities: [
          { $id: 'iA', key: 'email:a@example.com', type: 'email', personId: 'pA', verified: true },
          { $id: 'iB', key: 'email:b@example.com', type: 'email', personId: 'pB', verified: true },
        ],
        members: [placeholderRow('mA', 'g1', 'pA', BEFORE)],
        activity: [{ ...ABOUT_SAMMY, $id: 'aB', subjectPersonId: 'pB' }],
      },
      null,
    )
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 2, finished: 1 } })
    expect(subjectOf(services, 'aB')).toBe('pSam')
    expect(personOf(services, 'pB')?.mergeResumeAt).toBe(NOW.toISOString())
    expect(await hourly(services)).toMatchObject({ ok: true, data: { finished: 2 } })
    expect(personOf(services, 'pB')?.mergeResumeAt).toBeNull()
  })

  it('never clears a mark written again in the same millisecond, told apart by its rev', async () => {
    const services = seeded({}, null)
    const mark = () =>
      withTransaction(services.db, (tx) => markMergesToResume(tx, services.db, 'pSam', 'g1', NOW))
    await mark()
    const read = personOf(services, 'pP') as Persons
    // A second join, with the very same `now`, after the run read P and before its clear staged.
    await mark()
    expect(await clearResume(services.db, read)).toBe(false)
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(NOW.toISOString())
  })

  it('costs one read and no write when nobody is merged into the joiner', async () => {
    const services = seeded()
    // Sammy was never merged into Sam after all.
    await updateRow(services.db, 'persons', 'pP', { mergedInto: null })
    const list = vi.spyOn(services.db, 'listRows')
    await ok(services, 'POST', '/groups/g1/join')
    const mergedReads = list.mock.calls.filter(([params]) =>
      JSON.stringify(params.queries ?? []).includes('mergedInto'),
    )
    expect(mergedReads).toHaveLength(1)
    expect(services.db.rows('persons').map((row) => row.mergeResumeAt ?? null)).toEqual([
      null,
      null,
    ])
  })

  it('never clears a mark a join wrote after the run read it', async () => {
    const services = seeded({}, null)
    const later = new Date(NOW.getTime() + 60_000).toISOString()
    await updateRow(services.db, 'persons', 'pP', { mergeResumeAt: later })
    // The run read the mark from before the second join.
    const read = { ...(personOf(services, 'pP') as Persons), mergeResumeAt: NOW.toISOString() }
    expect(await clearResume(services.db, read)).toBe(false)
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(later)
    expect(await clearResume(services.db, personOf(services, 'pP') as Persons)).toBe(true)
    expect(personOf(services, 'pP')?.mergeResumeAt).toBeNull()
  })

  it('leaves the mark, and doesn’t throw, when a join marks P between the clear’s stage and commit', async () => {
    const services = seeded({}, null)
    await updateRow(services.db, 'persons', 'pP', { mergeResumeAt: NOW.toISOString() })
    const later = new Date(NOW.getTime() + 60_000).toISOString()
    // The clear's own check passes; the join's write lands just before its commit, which then
    // fails with 409.
    beforeCommit(services.db, () =>
      updateRow(services.db, 'persons', 'pP', { mergeResumeAt: later, rev: 'rAgain' }),
    )
    expect(await clearResume(services.db, personOf(services, 'pP') as Persons)).toBe(false)
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(later)
  })

  it('clears the marks of a deleted U’s merges, which never go on, so they’re skipped once', async () => {
    const services = seeded({}, null)
    await updateRow(services.db, 'persons', 'pP', { mergeResumeAt: NOW.toISOString() })
    await updateRow(services.db, 'persons', 'pSam', { deletedAt: NOW.toISOString() })
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 1, skipped: 1 } })
    expect(personOf(services, 'pP')?.mergeResumeAt).toBeNull()
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 0, skipped: 0 } })
  })

  it('logs a clear that fails for a deleted U’s merge, and reads an unmarked one only once', async () => {
    // Sammy is marked and Amy isn't; Amy still holds a key, so the walk finds both, Amy first.
    const services = seeded(
      {
        persons: [{ ...SAMMY, $id: 'pAmy' }],
        identities: [
          {
            $id: 'iAmy',
            key: 'email:amy@example.com',
            type: 'email',
            personId: 'pAmy',
            verified: true,
          },
        ],
      },
      null,
    )
    await updateRow(services.db, 'persons', 'pP', { mergeResumeAt: NOW.toISOString() })
    await updateRow(services.db, 'persons', 'pSam', { deletedAt: NOW.toISOString() })
    const getRow = vi.spyOn(services.db, 'getRow')
    vi.spyOn(services.db, 'updateTransaction').mockRejectedValue(new Error('Appwrite is down'))
    expect(await hourly(services)).toMatchObject({ ok: true, data: { unfinished: 2, skipped: 2 } })
    const reads = (id: string) => getRow.mock.calls.filter(([params]) => params.rowId === id)
    expect(reads('pAmy')).toHaveLength(1)
    const lines = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'merge_run_failed', personId: 'pP', intoPersonId: 'pSam' }),
    )
    expect(personOf(services, 'pP')?.mergeResumeAt).toBe(NOW.toISOString())
  })
})
