import { expect, type Page, type TestInfo } from '@playwright/test'

// The statements function's timeout (appwrite/functions.json), and a margin for a run that starts
// late after a cold start: a finalize still running when a flow stops waiting for it ends within
// this.
const FINALIZE_MS = 300_000 + 30_000

/** The statement's stored status, read in the page through the app's own client, as the user. */
function statusOf(page: Page, id: string): Promise<string> {
  return page.evaluate(
    async ({ path, id }) => {
      const { tablesDB, DATABASE_ID } = await import(path)
      const row = await tablesDB.getRow({
        databaseId: DATABASE_ID,
        tableId: 'statements',
        rowId: id,
      })
      return row.status
    },
    { path: '/src/lib/appwrite.ts', id },
  )
}

/**
 * Before a flow archives its group: archiving is refused while a statement is finalizing, so a
 * finalize that outlasts the flow's minute is waited out first, until FINALIZE_MS after Finalize
 * was clicked (`finalizedAt`), with that time added to the test's (#406). A read that fails
 * counts as still finalizing, so it's read again. The wait is never 0, which `expect.poll` reads
 * as no limit.
 */
export async function waitOutFinalize(
  page: Page,
  testInfo: TestInfo,
  statementId: string | undefined,
  finalizedAt: number | undefined,
): Promise<void> {
  const left = finalizedAt ? FINALIZE_MS - (Date.now() - finalizedAt) : 0
  if (!statementId || left <= 0) return
  if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + left)
  await expect
    .poll(() => statusOf(page, statementId).catch(() => 'finalizing'), {
      timeout: left,
      intervals: [2_000],
    })
    .not.toBe('finalizing')
}
