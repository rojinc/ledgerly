import { deleteRunUsers } from './dev-project'

/** After the run: every user it made, through the API or the app, is deleted from dev. */
export default async function globalTeardown() {
  // Setup stopped before making anything.
  if (!process.env.E2E_RUN_ID || !process.env.E2E_RUN_START) return
  await deleteRunUsers(process.env.E2E_RUN_START)
}
