import { describe, expect, it } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { leftOnTheirOwn } from './left-on-their-own'

const MEMBER_CREATED = '2026-09-01T00:00:00.000Z'

function activity(id: string, action: string, at: string, extra: object = {}) {
  return {
    $id: id,
    $createdAt: at,
    at,
    groupId: 'g1',
    actorPersonId: 'p2',
    action,
    transactionId: null,
    summary: 'Member m2',
    changesJson: null,
    ...extra,
  }
}

function check(rows: ReturnType<typeof activity>[]) {
  return leftOnTheirOwn(new FakeDb({ activity: rows }), 'g1', 'p2', MEMBER_CREATED)
}

describe('leftOnTheirOwn', () => {
  it('is true when their newest member.left or member.joined is member.left', async () => {
    expect(
      await check([
        activity('a1', 'member.joined', '2026-09-02T00:00:00.000Z'),
        activity('a2', 'member.left', '2026-10-01T00:00:00.000Z'),
        activity('a3', 'member.updated', '2026-10-02T00:00:00.000Z'),
      ]),
    ).toBe(true)
  })

  it('is false after a later member.joined, or with neither', async () => {
    expect(
      await check([
        activity('a1', 'member.left', '2026-09-10T00:00:00.000Z'),
        activity('a2', 'member.joined', '2026-09-20T00:00:00.000Z'),
      ]),
    ).toBe(false)
    expect(await check([activity('a1', 'member.updated', '2026-10-01T00:00:00.000Z')])).toBe(false)
  })

  it('ignores rows from before this member row, from others, and from other groups', async () => {
    expect(
      await check([
        activity('a1', 'member.left', '2026-08-01T00:00:00.000Z'),
        activity('a2', 'member.left', '2026-10-01T00:00:00.000Z', { actorPersonId: 'p1' }),
        activity('a3', 'member.left', '2026-10-01T00:00:00.000Z', { groupId: 'g2' }),
      ]),
    ).toBe(false)
  })
})
