import { describe, expect, it } from 'vitest'
import {
  beforeCommit,
  beforeStaging,
  createRow,
  failure,
  fakes,
  group,
  member,
  NOW,
  ok,
  person,
  TRY_AGAIN,
  updateRow,
} from './harness'

// October's close in Sydney: 06:00 on 1 November (AEDT, +11).
const SYDNEY_OCTOBER = '2026-10-31T19:00:00.000Z'

const EMPLOYER_SETTINGS = {
  type: 'employer',
  defaultRateCents: 3000,
  paymentTermsDays: 14,
  autoFinalize: false,
  recipients: [],
}

// u1 (p1) is g1's admin, u2 (p2) a member, u3 (p3) a placeholder; u4 (p4) isn't in it.
function setUp(type = 'house', extra: object = {}, seed: object = {}) {
  return fakes({
    persons: [person(1), person(2), person(3), person(4)],
    groups: [group('g1', type, extra)],
    members: [
      member('m1', 'g1', 'p1', 'admin', 'active'),
      member('m2', 'g1', 'p2', 'member', 'active'),
      member('m3', 'g1', 'p3', 'admin', 'placeholder'),
    ],
    ...seed,
  })
}

describe('PATCH /groups/{id}', () => {
  it('changes only the fields given, and records the change without the name', async () => {
    const services = setUp()
    const updated = await ok(services, 'PATCH', '/groups/g1', { name: 'Home', currency: 'NZD' })
    expect(updated).toMatchObject({
      $id: 'g1',
      name: 'Home',
      currency: 'NZD',
      timezone: 'Australia/Sydney',
      nextCloseAt: null,
      $permissions: ['read("team:g1")'],
    })
    const activity = services.db.rows('activity')
    expect(activity).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'group.updated',
        summary: "Changed the group's name, currency",
        at: NOW.toISOString(),
        $permissions: ['read("team:g1")'],
      }),
    ])
    // A pair group's name is a person's, so only the summary says it changed.
    expect(JSON.parse(String(activity[0]?.changesJson))).toEqual({
      before: { currency: 'AUD' },
      after: { currency: 'NZD' },
    })
  })

  it('stores no changes for a new name alone, which only the summary says', async () => {
    const services = setUp()
    await ok(services, 'PATCH', '/groups/g1', { name: 'Flat 3' })
    const activity = services.db.rows('activity')
    expect(activity).toEqual([expect.objectContaining({ summary: "Changed the group's name" })])
    expect(activity[0]?.changesJson ?? null).toBeNull()
  })

  it('changes the settings of the same type', async () => {
    const services = setUp('employer')
    const settings = { ...EMPLOYER_SETTINGS, recipients: ['pay@example.com'] }
    const updated = await ok(services, 'PATCH', '/groups/g1', { settings })
    expect(updated).toMatchObject({ settingsJson: JSON.stringify(settings) })
    // No email in the activity row: the recipients are only counted.
    const changesJson = String(services.db.rows('activity')[0]?.changesJson)
    expect(changesJson).not.toMatch(/@/)
    expect(JSON.parse(changesJson)).toEqual({
      before: { settings: { ...EMPLOYER_SETTINGS, recipients: 0 } },
      after: { settings: { ...EMPLOYER_SETTINGS, recipients: 1 } },
    })
    expect(services.db.rows('activity')[0]?.summary).not.toMatch(/@/)
  })

  it('moves nextCloseAt when the cycle, anchor or time zone changes', async () => {
    const services = setUp()
    const weekly = await ok(services, 'PATCH', '/groups/g1', {
      statementCycle: 'weekly',
      cycleAnchor: '2026-11-02',
    })
    // The week 2–8 November closes at 06:00 on 9 November in Sydney.
    expect(weekly).toMatchObject({ nextCloseAt: '2026-11-08T19:00:00.000Z' })
    const perth = await ok(services, 'PATCH', '/groups/g1', { timezone: 'Australia/Perth' })
    expect(perth).toMatchObject({ nextCloseAt: '2026-11-08T22:00:00.000Z' })
    const none = await ok(services, 'PATCH', '/groups/g1', { statementCycle: 'none' })
    expect(none).toMatchObject({ nextCloseAt: null })
  })

  it('keeps a nextCloseAt that is already due, for the statements cron', async () => {
    // 1 November 06:00 in Sydney has passed, but the cron hasn't drafted October yet.
    const due = '2026-10-31T19:00:00.000Z'
    const services = setUp('employer', { nextCloseAt: due })
    services.now = new Date('2026-11-01T01:00:00.000Z')
    const weekly = await ok(services, 'PATCH', '/groups/g1', {
      statementCycle: 'weekly',
      cycleAnchor: '2026-11-02',
    })
    expect(weekly).toMatchObject({ nextCloseAt: due })
    const none = await ok(services, 'PATCH', '/groups/g1', { statementCycle: 'none' })
    expect(none).toMatchObject({ nextCloseAt: null })
  })

  it.each([
    // West by 21 hours: October closes later, so the cron drafts it then, once.
    [
      'Sydney to Honolulu',
      SYDNEY_OCTOBER,
      'Australia/Sydney',
      'Pacific/Honolulu',
      '2026-11-01T16:00:00.000Z',
    ],
    // East by 15 hours: earlier, so it stays due, and October doesn't take 1 November.
    [
      'New York to Sydney',
      '2026-11-01T11:00:00.000Z',
      'America/New_York',
      'Australia/Sydney',
      SYDNEY_OCTOBER,
    ],
    [
      'Perth to Sydney',
      '2026-10-31T22:00:00.000Z',
      'Australia/Perth',
      'Australia/Sydney',
      SYDNEY_OCTOBER,
    ],
  ])('closes a due October in the new time zone, %s (#126)', async (_, due, from, to, closeAt) => {
    const services = setUp('employer', { nextCloseAt: due, timezone: from })
    services.now = new Date('2026-11-01T12:00:00.000Z')
    const moved = await ok(services, 'PATCH', '/groups/g1', { timezone: to })
    expect(moved).toMatchObject({ timezone: to, nextCloseAt: closeAt })
  })

  it.each([
    ['Brisbane', 'Australia/Brisbane', '2026-10-31T20:00:00.000Z'],
    ['Perth', 'Australia/Perth', '2026-10-31T22:00:00.000Z'],
    ['Honolulu', 'Pacific/Honolulu', '2026-11-01T16:00:00.000Z'],
  ])('keeps October through a move west to %s and back (#126)', async (_, zone, westClose) => {
    const services = setUp('employer', { nextCloseAt: SYDNEY_OCTOBER })
    services.now = new Date('2026-10-31T19:05:00.000Z')
    const west = await ok(services, 'PATCH', '/groups/g1', { timezone: zone })
    expect(west).toMatchObject({ nextCloseAt: westClose })
    // Not due yet in the new time zone, and October has already ended there.
    const back = await ok(services, 'PATCH', '/groups/g1', { timezone: 'Australia/Sydney' })
    expect(back).toMatchObject({ nextCloseAt: SYDNEY_OCTOBER })
  })

  it('closes the current period in the new time zone when nothing is due', async () => {
    // November closes at 06:00 on 1 December in Sydney.
    const services = setUp('employer', { nextCloseAt: '2026-11-30T19:00:00.000Z' })
    services.now = new Date('2026-11-10T00:00:00.000Z')
    const perth = await ok(services, 'PATCH', '/groups/g1', { timezone: 'Australia/Perth' })
    expect(perth).toMatchObject({ nextCloseAt: '2026-11-30T22:00:00.000Z' })
  })

  it('takes the new cycle from today when the time zone changes with it and nothing is due', async () => {
    const services = setUp('employer', { nextCloseAt: '2026-11-30T19:00:00.000Z' })
    services.now = new Date('2026-11-10T00:00:00.000Z')
    const weekly = await ok(services, 'PATCH', '/groups/g1', {
      timezone: 'Australia/Perth',
      statementCycle: 'weekly',
      cycleAnchor: '2026-11-02',
    })
    // The week 9–15 November closes at 06:00 on 16 November in Perth.
    expect(weekly).toMatchObject({ nextCloseAt: '2026-11-15T22:00:00.000Z' })
  })

  it('closes a due October in the new time zone when the cycle changes too', async () => {
    const services = setUp('employer', { nextCloseAt: SYDNEY_OCTOBER })
    services.now = new Date('2026-10-31T19:05:00.000Z')
    const moved = await ok(services, 'PATCH', '/groups/g1', {
      timezone: 'Pacific/Honolulu',
      statementCycle: 'weekly',
      cycleAnchor: '2026-11-02',
    })
    // October still ends on the 31st; the weekly periods start after it.
    expect(moved).toMatchObject({ nextCloseAt: '2026-11-01T16:00:00.000Z' })
  })

  it('keeps a due nextCloseAt exactly as stored when the time zone stays the same', async () => {
    // Stored before #126: New York's October close, after a move to Sydney.
    const due = '2026-11-01T11:00:00.000Z'
    const services = setUp('employer', { nextCloseAt: due })
    services.now = new Date('2026-11-01T12:00:00.000Z')
    const weekly = await ok(services, 'PATCH', '/groups/g1', {
      statementCycle: 'weekly',
      cycleAnchor: '2026-11-02',
      timezone: 'Australia/Sydney',
    })
    expect(weekly).toMatchObject({ nextCloseAt: due })
  })

  it('compares a due nextCloseAt as an instant, whatever its offset', async () => {
    // 19:00 UTC on 31 October, written with Sydney's offset: later as text, earlier in time.
    const due = '2026-11-01T06:00:00.000+11:00'
    const services = setUp('employer', { nextCloseAt: due })
    services.now = new Date('2026-10-31T20:00:00.000Z')
    // Due, so October is closed again in Perth: 06:00 on 1 November there.
    const perth = await ok(services, 'PATCH', '/groups/g1', { timezone: 'Australia/Perth' })
    expect(perth).toMatchObject({ nextCloseAt: '2026-10-31T22:00:00.000Z' })
  })

  it('keeps nextCloseAt when nothing it depends on changes', async () => {
    const services = setUp('employer', { nextCloseAt: '2026-10-31T19:00:00.000Z' })
    const updated = await ok(services, 'PATCH', '/groups/g1', { name: 'Work', region: 'AU-VIC' })
    expect(updated).toMatchObject({ region: 'AU-VIC', nextCloseAt: '2026-10-31T19:00:00.000Z' })
  })

  it.each([
    ['an empty body', {}],
    ['the stored values', { name: 'Group g1', currency: 'AUD' }],
  ])('writes nothing for %s', async (_, body) => {
    const services = setUp()
    const before = services.db.rows('groups')[0]
    expect(await ok(services, 'PATCH', '/groups/g1', body)).toEqual(before)
    expect(services.db.rows('activity')).toEqual([])
  })

  it("can't change the currency after the first transaction", async () => {
    const services = setUp('house', {}, { transactions: [{ $id: 't1', groupId: 'g1' }] })
    expect(await failure(services, 'PATCH', '/groups/g1', { currency: 'NZD' })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('groups')[0]?.currency).toBe('AUD')
  })

  it('sees a first transaction committed after the first read', async () => {
    const services = setUp()
    beforeStaging(services.db, 1, () =>
      createRow(services.db, 'transactions', {
        $id: 't1',
        groupId: 'g1',
        kind: 'expense',
        status: 'posted',
        date: '2026-10-19',
        description: 'Rent',
        totalCents: 100,
        inputJson: '{}',
        createdBy: 'p1',
        updatedBy: 'p1',
      }),
    )
    expect(await failure(services, 'PATCH', '/groups/g1', { currency: 'NZD' })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('groups')[0]?.currency).toBe('AUD')
    expect(services.db.rows('activity')).toEqual([])
  })

  it.each([
    ['settings of another type', { settings: { type: 'pair' } }],
    ['a weekly cycle without an anchor', { statementCycle: 'weekly' }],
    ['an unknown region', { region: 'AU-NWS' }],
    ['an unknown field', { type: 'pair' }],
  ])('refuses %s', async (_, body) => {
    const services = setUp()
    expect(await failure(services, 'PATCH', '/groups/g1', body)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('takes a weekly cycle when the group already has an anchor', async () => {
    const services = setUp('house', { cycleAnchor: '2026-10-05' })
    const updated = await ok(services, 'PATCH', '/groups/g1', { statementCycle: 'fortnightly' })
    // The fortnight 19 October – 1 November closes at 06:00 on 2 November in Sydney.
    expect(updated).toMatchObject({ nextCloseAt: '2026-11-01T19:00:00.000Z' })
  })

  it('refuses someone who left on their own as not a member, not as a viewer (#117)', async () => {
    // Left voluntarily: a `left` viewer row, and out of the team (no team seeded).
    const services = setUp(
      'house',
      {},
      {
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active'),
          member('m4', 'g1', 'p4', 'viewer', 'left'),
        ],
      },
    )
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'X' }, 'u4')).toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    })
  })

  it('refuses someone who left on their own while the team still exists with others (#121)', async () => {
    const services = fakes(
      {
        persons: [person(1), person(4)],
        groups: [group('g1', 'house')],
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active'),
          member('m4', 'g1', 'p4', 'viewer', 'left'),
        ],
      },
      { g1: ['u1'] },
    )
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'X' }, 'u4')).toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    })
  })

  it('is for admins only', async () => {
    const services = setUp()
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'X' }, 'u2')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it.each([
    ['a placeholder', 'u3'],
    ['someone outside the group', 'u4'],
  ])('refuses %s', async (_, userId) => {
    const services = setUp()
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'X' }, userId)).toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    })
  })

  it('refuses an archived group', async () => {
    const services = setUp('house', { archivedAt: '2026-10-01T00:00:00.000Z' })
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'X' })).toMatchObject({
      status: 409,
      code: 'ARCHIVED',
    })
  })

  it('needs a logged-in user', async () => {
    const services = setUp()
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'X' }, null)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
  })

  it('answers CONFLICT when the group changed after the first read', async () => {
    const services = setUp('house', { $updatedAt: '2026-10-01T00:00:00.000Z' })
    beforeStaging(services.db, 1, () => updateRow(services.db, 'groups', 'g1', { name: 'Other' }))
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'Home' })).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('groups')[0]?.name).toBe('Other')
    expect(services.db.rows('activity')).toEqual([])
  })

  it('answers CONFLICT when the group was archived after the first read', async () => {
    const services = setUp('employer', {
      $updatedAt: '2026-10-01T00:00:00.000Z',
      nextCloseAt: '2026-10-31T13:00:00.000Z',
    })
    const archivedAt = '2026-10-18T19:59:00.000Z'
    beforeStaging(services.db, 1, () =>
      updateRow(services.db, 'groups', 'g1', { archivedAt, nextCloseAt: null }),
    )
    const body = { timezone: 'Australia/Perth' }
    expect(await failure(services, 'PATCH', '/groups/g1', body)).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // The archive stands: no time zone change, and no nextCloseAt to bring statements back.
    expect(services.db.rows('groups')[0]).toMatchObject({
      archivedAt,
      nextCloseAt: null,
      timezone: 'Australia/Sydney',
    })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('answers CONFLICT when the group changes at the same time', async () => {
    const services = setUp()
    beforeCommit(services.db, () => updateRow(services.db, 'groups', 'g1', { name: 'Other' }))
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'Home' })).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
  })
})
