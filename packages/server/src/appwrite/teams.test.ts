import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import { FakeTeams } from './fake-teams'
import { addToTeam, ensureTeam, isInTeam, removeFromTeam } from './teams'

describe('ensureTeam', () => {
  it('creates the team with no roles, and counts one that already exists as done', async () => {
    const teams = new FakeTeams()
    const create = vi.spyOn(teams, 'create')
    await ensureTeam(teams, 'g1', 'Personal')
    await ensureTeam(teams, 'g1', 'Personal')
    expect(teams.teamIds()).toEqual(['g1'])
    expect(teams.members('g1')).toEqual([])
    expect(create).toHaveBeenCalledWith({ teamId: 'g1', name: 'Personal', roles: [] })
  })

  it('rethrows any other error', async () => {
    const teams = new FakeTeams()
    vi.spyOn(teams, 'create').mockRejectedValue(new AppwriteException('Down', 503))
    await expect(ensureTeam(teams, 'g1', 'Personal')).rejects.toMatchObject({ code: 503 })
  })
})

describe('addToTeam', () => {
  it('adds the user with no roles, never owner, and counts "already a member" as done', async () => {
    const teams = new FakeTeams({ g1: [] })
    await addToTeam(teams, 'g1', 'u1')
    await addToTeam(teams, 'g1', 'u1')
    expect(teams.members('g1')).toEqual([{ $id: expect.any(String), userId: 'u1', roles: [] }])
  })

  it('rethrows a missing team', async () => {
    await expect(addToTeam(new FakeTeams(), 'nope', 'u1')).rejects.toMatchObject({ code: 404 })
  })
})

describe('removeFromTeam', () => {
  it('removes only that user', async () => {
    const teams = new FakeTeams({ g1: ['u1', 'u2'] })
    await removeFromTeam(teams, 'g1', 'u1')
    expect(teams.members('g1')?.map((membership) => membership.userId)).toEqual(['u2'])
  })

  it("deletes only a membership with that user ID, not only through the query's filter (#121)", async () => {
    const teams = new FakeTeams({ g1: ['u1', 'u2'] })
    const other = teams.members('g1')?.find((membership) => membership.userId === 'u2')
    vi.spyOn(teams, 'listMemberships').mockResolvedValue({
      total: 1,
      memberships: [other as never],
    })
    const deleteMembership = vi.spyOn(teams, 'deleteMembership')
    await removeFromTeam(teams, 'g1', 'u1')
    expect(deleteMembership).not.toHaveBeenCalled()
  })

  it('counts a membership or team that is already gone as done', async () => {
    const teams = new FakeTeams({ g1: ['u2'] })
    await removeFromTeam(teams, 'g1', 'u1')
    await removeFromTeam(teams, 'nope', 'u1')
    expect(teams.members('g1')).toHaveLength(1)
  })

  it('counts a membership deleted meanwhile as done, and rethrows other errors', async () => {
    const teams = new FakeTeams({ g1: ['u1'] })
    const deleteMembership = vi.spyOn(teams, 'deleteMembership')
    deleteMembership.mockRejectedValueOnce(new AppwriteException('Gone', 404))
    await removeFromTeam(teams, 'g1', 'u1')
    deleteMembership.mockRejectedValueOnce(new AppwriteException('Down', 503))
    await expect(removeFromTeam(teams, 'g1', 'u1')).rejects.toMatchObject({ code: 503 })
  })
})

describe('FakeTeams', () => {
  it('refuses what it does not model, and 404s for a missing membership', async () => {
    const teams = new FakeTeams({ g1: ['u1'] })
    await expect(teams.createMembership({ teamId: 'g1', roles: [] })).rejects.toThrow('by ID')
    await expect(
      teams.listMemberships({ teamId: 'g1', queries: ['{"method":"search"}'] }),
    ).rejects.toThrow('does not support')
    await expect(teams.deleteMembership({ teamId: 'g1', membershipId: 'x' })).rejects.toMatchObject(
      { code: 404 },
    )
  })
})

describe('isInTeam', () => {
  it('is true only for a member of the team, and false for a team that is gone', async () => {
    const teams = new FakeTeams({ g1: ['u1', 'u2'] })
    expect(await isInTeam(teams, 'g1', 'u1')).toBe(true)
    expect(await isInTeam(teams, 'g1', 'u3')).toBe(false)
    expect(await isInTeam(teams, 'gone', 'u1')).toBe(false)
  })

  it("checks the user ID itself, not only the query's filter (#121)", async () => {
    // As if the filter were dropped: Teams answers with someone else's membership.
    const teams = { listMemberships: async () => ({ memberships: [{ $id: 'x', userId: 'u2' }] }) }
    expect(await isInTeam(teams, 'g1', 'u1')).toBe(false)
  })

  it('rethrows any other error', async () => {
    const teams = {
      listMemberships: async () => {
        throw new AppwriteException('Server error', 500)
      },
    }
    await expect(isInTeam(teams, 'g1', 'u1')).rejects.toMatchObject({ code: 500 })
  })
})
