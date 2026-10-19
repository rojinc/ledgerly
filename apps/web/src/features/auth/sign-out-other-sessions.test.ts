import { AppwriteException } from 'appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { signOutOtherSessions } from './sign-out-other-sessions'

vi.mock('../../lib/appwrite', () => ({
  account: { listSessions: vi.fn(), deleteSession: vi.fn(), deleteSessions: vi.fn() },
}))

const list = vi.mocked(account.listSessions)
const remove = vi.mocked(account.deleteSession)

function sessions(...current: boolean[]) {
  return {
    total: current.length,
    sessions: current.map((isCurrent, i) => ({ $id: `s${i}`, current: isCurrent })),
  } as never
}

describe('signOutOtherSessions', () => {
  afterEach(() => vi.resetAllMocks())

  it('deletes every session but the current one, and counts them', async () => {
    list.mockResolvedValue(sessions(false, true, false))
    remove.mockResolvedValue({})
    expect(await signOutOtherSessions()).toBe(2)
    expect(remove.mock.calls).toEqual([[{ sessionId: 's0' }], [{ sessionId: 's2' }]])
    // It would delete this one too on Appwrite 1.8.1.
    expect(account.deleteSessions).not.toHaveBeenCalled()
  })

  it('deletes nothing when this is the only one', async () => {
    list.mockResolvedValue(sessions(true))
    expect(await signOutOtherSessions()).toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })

  it('counts a session that is already gone (404) as signed out', async () => {
    list.mockResolvedValue(sessions(false, true, false))
    remove
      .mockRejectedValueOnce(new AppwriteException('Gone', 404, 'user_session_not_found'))
      .mockResolvedValue({})
    expect(await signOutOtherSessions()).toBe(2)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['offline', new TypeError('Failed to fetch')],
    ['a 500', new AppwriteException('Boom', 500, 'general_unknown')],
  ])('fails when a delete fails any other way (%s)', async (_, error) => {
    list.mockResolvedValue(sessions(false, true))
    remove.mockRejectedValue(error)
    await expect(signOutOtherSessions()).rejects.toBe(error)
  })
})
