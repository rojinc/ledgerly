import { randomBytes } from 'node:crypto'
import { createUser, ENV_NAMES } from './dev-project'

/**
 * Before any flow: the dev project's variables, this run's ID and start time, and the users the
 * flows sign in as (verified, through the API). Workers get them through the environment.
 */
export default async function globalSetup() {
  const missing = ENV_NAMES.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(', ')} to run the e2e flows against dev (docs/engineering/testing.md#end-to-end).`,
    )
  }
  // Letters and digits only, so it's one word in a name or an address.
  process.env.E2E_RUN_ID = `e2e${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  process.env.E2E_RUN_START = new Date().toISOString()
  const users = {
    // Flow 1's user A, who adds B before B signs up.
    alex: await createUser('alex', 'Alex'),
    // Flow 2's worker.
    sam: await createUser('sam', 'Sam'),
  }
  process.env.E2E_USERS = JSON.stringify(users)
}
