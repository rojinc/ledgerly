import { randomBytes } from 'node:crypto'
import { createUser, ENV_NAMES, handOverRunUsers, userState } from './dev-project'

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
  let made: string[] = []
  const teardown = async () => {
    await handOverRunUsers(runId)
    // Every user made is handed over, the passwordless ones included, or gone, as one whose flow
    // deleted their account is (#525). One still live would be an account nobody signs out.
    const live: string[] = []
    for (const id of made) if ((await userState(id)) === 'live') live.push(id)
    if (live.length > 0) {
      throw new Error(`${live.length} of the ${made.length} users made are still live`)
    }
    if (process.env.E2E_MOCK === '1') await expectMockServedAll()
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
      // #525's flow: Fay deletes her account, then Gil, who moved out of her house, deletes the
      // house. Neither has a password, so neither is refused for 24 hours.
      fay: await createUser('fay', 'Fay', { password: false }),
      gil: await createUser('gil', 'Gil', { password: false }),
      // Flows 6–10, one each (#526). Flow 9's claimer, Pat, is made in its flow, after Ivy adds
      // Pat's address, and is swept by the run's address like the rest.
      ida: await createUser('ida', 'Ida'),
      gus: await createUser('gus', 'Gus'),
      hal: await createUser('hal', 'Hal'),
      ivy: await createUser('ivy', 'Ivy'),
      jon: await createUser('jon', 'Jon'),
    }
    made = Object.values(users).map((user) => user.id)
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

/**
 * On the mock (#554), a request from the app or the runner that it has no route for answers 404,
 * and a query it doesn't model 400, which a flow may not notice: either fails the run here
 * instead, with the routes and queries in `packages/e2e-mock/dist/mock.log`. A function's calls go
 * to in-process services, so a new one fails `npm run typecheck`.
 */
async function expectMockServedAll(): Promise<void> {
  const origin = new URL(process.env.VITE_APPWRITE_ENDPOINT ?? '').origin
  const { unhandled } = (await (await fetch(`${origin}/mock/stats`)).json()) as {
    unhandled: number
  }
  if (unhandled > 0) {
    throw new Error(
      `The mock had no route or query for ${unhandled} request${unhandled === 1 ? '' : 's'}: see packages/e2e-mock/dist/mock.log`,
    )
  }
}
