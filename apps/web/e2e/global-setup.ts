import { randomBytes } from 'node:crypto'
import { createUser, ENV_NAMES, handOverRunUsers } from './dev-project'

/**
 * Before any flow: the dev project's variables, this run's ID, and the users the flows log in
 * as (verified, through the API). Workers get them through the environment. Returns the
 * teardown, which hands every user the run made to the `account` job to delete (#386); if setup
 * fails partway, it hands them over then.
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
  let made = 0
  const teardown = async () => {
    const handedOver = await handOverRunUsers(runId)
    // Every user made, the passwordless one included: one left out would be a live account.
    if (handedOver < made) throw new Error(`Handed over ${handedOver} of the ${made} users made`)
  }
  try {
    const users = {
      // Flow 1's user A, who adds B before B has an account.
      alex: await createUser('alex', 'Alex'),
      // The workers of flows 2–5, one each, so each flow starts from an empty dashboard.
      sam: await createUser('sam', 'Sam'),
      kim: await createUser('kim', 'Kim'),
      lee: await createUser('lee', 'Lee'),
      max: await createUser('max', 'Max'),
      // #512's flows, one each. Ann deletes with a password set today, so she's refused; Bea has
      // no password, so she isn't, and signs in with an API token instead.
      ann: await createUser('ann', 'Ann'),
      bea: await createUser('bea', 'Bea', { password: false }),
      cal: await createUser('cal', 'Cal'),
      dee: await createUser('dee', 'Dee'),
      eve: await createUser('eve', 'Eve'),
    }
    made = Object.keys(users).length
    process.env.E2E_USERS = JSON.stringify(users)
  } catch (error) {
    // The setup's error is the one to see; a failed clean-up is added to it. Both messages
    // name routes and status codes only (dev-project.ts).
    await teardown().catch((cleanup: Error) => {
      const message = `${(error as Error).message}; handing the run's users over failed too: ${cleanup.message}`
      throw new Error(message, { cause: error })
    })
    throw error
  }
  return teardown
}
