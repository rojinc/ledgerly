import { randomBytes } from 'node:crypto'
import { createUser, deleteRunUsers, ENV_NAMES } from './dev-project'

/**
 * Before any flow: the dev project's variables, this run's ID, and the users the flows log in
 * as (verified, through the API). Workers get them through the environment. Returns the
 * teardown, which deletes every user the run made; if setup fails partway, it deletes them then.
 */
export default async function globalSetup() {
  const missing = ENV_NAMES.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(', ')} to run the e2e flows against dev (docs/engineering/testing.md#end-to-end).`,
    )
  }
  // Letters and digits only, so it's one word in a name or an address.
  const runId = `e2e${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  process.env.E2E_RUN_ID = runId
  const teardown = async () => {
    await deleteRunUsers(runId)
  }
  try {
    const users = {
      // Flow 1's user A, who adds B before B has an account.
      alex: await createUser('alex', 'Alex'),
      // Flow 2's worker.
      sam: await createUser('sam', 'Sam'),
    }
    process.env.E2E_USERS = JSON.stringify(users)
  } catch (error) {
    // The setup's error is the one to see; a failed clean-up is added to it. Both messages
    // name routes and status codes only (dev-project.ts).
    await teardown().catch((cleanup: Error) => {
      const message = `${(error as Error).message}; deleting the run's users failed too: ${cleanup.message}`
      throw new Error(message, { cause: error })
    })
    throw error
  }
  return teardown
}
