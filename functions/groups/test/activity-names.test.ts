import { describe, expect, it } from 'vitest'
import { fakes, group, member, ok, person, placeholder, profile } from './harness'

// Every name in this test, each a word that appears nowhere else, so a summary or changesJson
// that holds one is caught: person, member and group names, before and after a rename.
const NAMES = {
  person1: 'Aldous',
  person2: 'Brisco',
  person3: 'Caddock',
  placeholder: 'Dunmore',
  admin: 'Elspeth',
  renamed: 'Fitzroy',
  leaver: 'Gwendal',
  removed: 'Hobart',
  house: 'Ithaca',
  pair: 'Jessamy',
  counterpart: 'Kestrel',
  added: 'Lorcan',
  newName: 'Mirabel',
  newHouseName: 'Nerissa',
}

describe('groups activity rows', () => {
  it('never hold a member, person or group name, and every member row names its person', async () => {
    const services = fakes(
      {
        persons: [
          person(1, { displayName: NAMES.person1 }),
          person(2, { displayName: NAMES.person2 }),
          person(3, { displayName: NAMES.person3 }),
          placeholder('pX', NAMES.placeholder),
        ],
        profiles: [profile(1)],
        groups: [group('g1', 'house', { name: NAMES.house })],
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active', { displayName: NAMES.admin }),
          member('m2', 'g1', 'p2', 'member', 'active', { displayName: NAMES.renamed }),
          member('m3', 'g1', 'p3', 'member', 'active', { displayName: NAMES.leaver }),
          member('m4', 'g1', 'pX', 'member', 'placeholder', { displayName: NAMES.removed }),
        ],
      },
      { g1: ['u1', 'u2', 'u3'] },
    )
    await ok(services, 'POST', '/groups', {
      id: 'g2',
      type: 'pair',
      name: NAMES.pair,
      counterpart: { displayName: NAMES.counterpart },
    })
    await ok(services, 'POST', '/groups/g1/members', { displayName: NAMES.added })
    await ok(services, 'PATCH', '/groups/g1/members/m2', {
      displayName: NAMES.newName,
      joinedOn: '2026-08-15',
    })
    await ok(services, 'PATCH', '/groups/g1/members/m4', { leftOn: '2026-10-19' })
    await ok(services, 'DELETE', '/groups/g1/members/m4')
    await ok(services, 'POST', '/groups/g1/leave', undefined, 'u3')
    await ok(services, 'PATCH', '/groups/g1', { name: NAMES.newHouseName })
    await ok(services, 'POST', '/groups/g1/archive')

    const rows = services.db.rows('activity')
    // Every route that writes an activity row ran.
    expect(rows.map((row) => row.action)).toEqual([
      'group.created',
      'member.added',
      'member.added',
      'member.updated',
      'member.updated',
      'member.removed',
      'member.left',
      'group.updated',
      'group.archived',
    ])
    for (const row of rows) {
      const text = `${row.summary} ${row.changesJson ?? ''}`
      for (const name of Object.values(NAMES)) expect(text).not.toContain(name)
      if (String(row.action).startsWith('member.')) {
        expect(row.subjectPersonId).toEqual(expect.any(String))
      }
    }
  })
})
