// One-off for #163: receiptFiles rows for files uploaded before the ledger kept them
// (data-model.md#receiptfiles). The lead runs it once in each environment, from main, after the
// ledger change is deployed there and a minute has passed, so no execution of the old ledger is
// still running (they time out after 15 s). Scheduler step 5 does nothing until its last write:
//   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node scripts/backfill-receipt-files.mjs
// Use a one-off key with rows.read, rows.write and files.read, and delete it afterwards. It
// prints counts only. Safe to run again.
import { bundleBackfill } from './backfill-bundle.mjs'

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY.')
  process.exit(1)
}

// The tested TypeScript, and the clients from the same bundle (scripts/backfill-bundle.mjs).
const { backfillReceiptFiles, Client, Query, Storage, TablesDB } = await bundleBackfill()
const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID)
  .setKey(APPWRITE_API_KEY)
const storage = new Storage(client)
// A page of file IDs by ID. listFiles pages by cursor; the backfill deletes no file.
const files = async (after) => {
  const { files: page } = await storage.listFiles({
    bucketId: 'receipts',
    queries: [
      Query.orderAsc('$id'),
      Query.limit(100),
      ...(after === undefined ? [] : [Query.cursorAfter(after)]),
    ],
    total: false,
  })
  return page.map((file) => file.$id)
}
const counts = await backfillReceiptFiles(new TablesDB(client), files, new Date())
console.log(counts)
if (counts.deleting > 0) {
  // Step 5 is deleting files that transactions list: stop it and look before going on.
  console.error(`${counts.deleting} receiptFiles rows are being deleted but listed. Check them.`)
  process.exitCode = 1
}
