import { describe, expect, it } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { AppError } from '../http/app-error'
import { requireMember, requireUser } from './require-member'

function db() {
  return new FakeDb({
    persons: [
      { $id: 'pAdmin', userId: 'uAdmin' },
      { $id: 'pViewer', userId: 'uViewer' },
      { $id: 'pPlaceholder', userId: 'uPlaceholder' },
      { $id: 'pLeft', userId: 'uLeft' },
      { $id: 'pOutsider', userId: 'uOutsider' },
    ],
    members: [
      { $id: 'm1', groupId: 'g1', personId: 'pAdmin', role: 'admin', status: 'active' },
      { $id: 'm2', groupId: 'g1', personId: 'pViewer', role: 'viewer', status: 'active' },
      { $id: 'm3', groupId: 'g1', personId: 'pPlaceholder', role: 'admin', status: 'placeholder' },
      { $id: 'm4', groupId: 'g1', personId: 'pLeft', role: 'viewer', status: 'left' },
      { $id: 'm5', groupId: 'g2', personId: 'pOutsider', role: 'admin', status: 'active' },
      { $id: 'm6', groupId: 'gArchived', personId: 'pAdmin', role: 'admin', status: 'active' },
    ],
    groups: [
      { $id: 'g1', type: 'house', archivedAt: null },
      { $id: 'g2', type: 'house', archivedAt: null },
      { $id: 'gArchived', type: 'house', archivedAt: '2026-10-01T00:00:00.000Z' },
    ],
  })
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(AppError)
  return (error as AppError).code
}

describe('requireMember', () => {
  it('returns the caller person, member row and group', async () => {
    const membership = await requireMember(db(), 'uAdmin', 'g1', { roles: ['admin'] })
    expect(membership.person.$id).toBe('pAdmin')
    expect(membership.member.$id).toBe('m1')
    expect(membership.group.$id).toBe('g1')
  })

  it('is UNAUTHENTICATED without a caller', async () => {
    expect(await codeOf(requireMember(db(), null, 'g1'))).toBe('UNAUTHENTICATED')
  })

  it.each([
    ['a user with no person yet', 'uNew', 'g1'],
    ['a person with no member row in the group', 'uOutsider', 'g1'],
    ['a placeholder, even an admin with an account (D-016)', 'uPlaceholder', 'g1'],
    ['a group that does not exist', 'uAdmin', 'nope'],
  ])('is NOT_A_MEMBER for %s', async (_, userId, groupId) => {
    expect(await codeOf(requireMember(db(), userId, groupId))).toBe('NOT_A_MEMBER')
  })

  it('is FORBIDDEN when the role is not allowed', async () => {
    expect(await codeOf(requireMember(db(), 'uViewer', 'g1', { roles: ['admin', 'member'] }))).toBe(
      'FORBIDDEN',
    )
  })

  it('lets any joined role through by default, including people who left', async () => {
    expect((await requireMember(db(), 'uViewer', 'g1')).member.role).toBe('viewer')
    expect((await requireMember(db(), 'uLeft', 'g1')).member.status).toBe('left')
  })

  it('is ARCHIVED for an archived group unless the route only reads', async () => {
    expect(await codeOf(requireMember(db(), 'uAdmin', 'gArchived'))).toBe('ARCHIVED')
    const read = await requireMember(db(), 'uAdmin', 'gArchived', { allowArchived: true })
    expect(read.group.$id).toBe('gArchived')
  })

  it('checks membership before role, and role before archived', async () => {
    expect(await codeOf(requireMember(db(), 'uOutsider', 'gArchived', { roles: ['admin'] }))).toBe(
      'NOT_A_MEMBER',
    )
    const viewerOfArchived = new FakeDb({
      persons: [{ $id: 'p', userId: 'u' }],
      members: [{ $id: 'm', groupId: 'g', personId: 'p', role: 'viewer', status: 'active' }],
      groups: [{ $id: 'g', archivedAt: '2026-10-01T00:00:00.000Z' }],
    })
    expect(await codeOf(requireMember(viewerOfArchived, 'u', 'g', { roles: ['admin'] }))).toBe(
      'FORBIDDEN',
    )
  })
})

describe('requireUser', () => {
  it('returns the caller or throws UNAUTHENTICATED', () => {
    expect(requireUser('u1')).toBe('u1')
    expect(() => requireUser(null)).toThrow(AppError)
    expect(() => requireUser('')).toThrow('Log in to continue.')
  })
})
