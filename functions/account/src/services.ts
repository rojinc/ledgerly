import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { type Models, Storage, Teams, Users } from 'node-appwrite'

// `POST /delete` and `POST /groups/{id}/delete` stop starting new work after this, inside the
// 30 s synchronous limit; the hourly job deletes the rest (functions-api.md#account).
export const ROUTE_BUDGET_MS = 20_000
// The hourly job stops taking new work after this, well inside the function's 900 s timeout
// (environments-and-deploys.md); the next run picks up the rest.
export const JOB_BUDGET_MS = 12 * 60_000

/** The parts of an Appwrite account that deletion reads. */
export type AccountUser = Pick<
  Models.User,
  '$id' | '$updatedAt' | 'email' | 'labels' | 'passwordUpdate' | 'status'
>

/** The parts of Users that account uses; the real `Users` satisfies it. */
export interface UsersApi {
  get(params: { userId: string }): Promise<AccountUser>
  listSessions(params: {
    userId: string
  }): Promise<{ sessions: Array<Pick<Models.Session, '$id' | '$createdAt'>> }>
  updateLabels(params: { userId: string; labels: string[] }): Promise<unknown>
  updateStatus(params: { userId: string; status: boolean }): Promise<unknown>
  deleteSessions(params: { userId: string }): Promise<unknown>
  delete(params: { userId: string }): Promise<unknown>
  /** Only for the hourly job, which lists the users labelled `deleted` or `e2e`. */
  list(params: { queries: string[]; total: boolean }): Promise<{ users: AccountUser[] }>
}

/** The parts of Storage that account uses, for a purged group's files; the real `Storage` fits. */
export interface FilesApi {
  getFile(params: { bucketId: string; fileId: string }): Promise<Pick<Models.File, '$permissions'>>
  deleteFile(params: { bucketId: string; fileId: string }): Promise<unknown>
}

/** What the routes work with, so tests can pass FakeDb, fakes and a fixed clock. */
export type Services = {
  db: Db
  teams: TeamsApi
  users: UsersApi
  files: FilesApi
  now: Date
  /** True once this request's time budget is used up. */
  outOfTime: () => boolean
}

/** The real services for one request, with the per-execution API key and its time budget. */
export function servicesFromRequest(
  ctx: Pick<RouteContext, 'db' | 'headers'>,
  budgetMs: number,
): Services {
  const stopAt = performance.now() + budgetMs
  const client = clientFromRequest(ctx.headers)
  return {
    db: ctx.db,
    teams: new Teams(client),
    users: new Users(client),
    files: new Storage(client),
    now: new Date(),
    outOfTime: () => performance.now() >= stopAt,
  }
}
