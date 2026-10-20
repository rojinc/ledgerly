// One-off for #342: `orphanedAt` on placeholders that removals left with no member row before the
// column existed (data-model.md#persons), so scheduler step 5c clears them 30 days later. The lead
// runs it once in each environment, from main, after the change is deployed there and a minute has
// passed, so no execution of the old groups function is still removing rows (they time out after
// 15 s):
//   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node scripts/backfill-orphaned-at.mjs
// Use a one-off key with rows.read and rows.write, and delete it afterwards. It prints counts
// only. Safe to run again.
import { bundleBackfill } from './backfill-bundle.mjs'

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY.')
  process.exit(1)
}

// The tested TypeScript, and the client from the same bundle (scripts/backfill-bundle.mjs).
const { backfillOrphanedAt, Client, TablesDB } = await bundleBackfill()
const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID)
  .setKey(APPWRITE_API_KEY)
console.log(await backfillOrphanedAt(new TablesDB(client), new Date()))
