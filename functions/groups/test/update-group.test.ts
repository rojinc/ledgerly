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
  it('changes only the fields given, and records the change', async () => {
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
        summary: "Member m1 changed the group's name, currency",
        at: NOW.toISOString(),
        $permissions: ['read("team:g1")'],
      }),
    ])
    expect(JSON.parse(String(activity[0]?.changesJson))).toEqual({
      before: { name: 'Group g1', currency: 'AUD' },
      after: { name: 'Home', currency: 'NZD' },
    })
  })

  it('changes the settings of the same type', async () => {
    const services = setUp('employer')
    const settings = { ...EMPLOYER_SETTINGS, recipients: ['pay@example.com'] }
    const updated = await ok(services, 'PATCH', '/groups/g1', { settings })
    expect(updated).toMatchObject({ settingsJson: JSON.stringify(settings) })
    const changes = JSON.parse(String(services.db.rows('activity')[0]?.changesJson))
    expect(changes).toEqual({ before: { settings: EMPLOYER_SETTINGS }, after: { settings } })
    // No email in the summary.
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

  it('answers CONFLICT when the group changes at the same time', async () => {
    const services = setUp()
    beforeCommit(services.db, () => updateRow(services.db, 'groups', 'g1', { name: 'Other' }))
    expect(await failure(services, 'PATCH', '/groups/g1', { name: 'Home' })).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
  })
})
