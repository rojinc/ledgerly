import type { Db } from '@ledgerly/server/appwrite/client'
import { type Email, sendEmail } from '@ledgerly/server/email/send-email'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { type Files, filesFromRequest } from './files'

/** What the routes work with, so tests can pass FakeDb, fake files and email, and a fixed clock. */
export type Services = {
  db: Db
  files: Files
  sendEmail: (email: Email) => Promise<unknown>
  now: Date
  /** The web app's address, for links in emails (environments-and-deploys.md: `APP_URL`). */
  appUrl: string
}

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  return {
    db: ctx.db,
    files: filesFromRequest(ctx.headers),
    sendEmail,
    now: new Date(),
    appUrl: process.env.APP_URL ?? '',
  }
}
