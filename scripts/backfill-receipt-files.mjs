// One-off for #163: receiptFiles rows for files uploaded before the ledger kept them
// (data-model.md#receiptfiles). Run it once in each environment, after the ledger change is
// deployed and before scheduler step 5 is:
//   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node scripts/backfill-receipt-files.mjs
// The key needs rows.read, rows.write and files.read. It prints counts only. Safe to run again.
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Client, Query, Storage, TablesDB } from 'node-appwrite'

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY.')
  process.exit(1)
}

// The tested TypeScript, bundled as the functions are (scripts/build-functions.mjs).
const root = fileURLToPath(new URL('..', import.meta.url))
const { outputFiles } = await build({
  entryPoints: [`${root}/functions/ledger/src/backfill-receipt-files.ts`],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  write: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
const bundle = `${tmpdir()}/backfill-receipt-files-${process.pid}.mjs`
writeFileSync(bundle, outputFiles[0].text)
try {
  const { backfillReceiptFiles } = await import(pathToFileURL(bundle).href)
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
  console.log(await backfillReceiptFiles(new TablesDB(client), files, new Date()))
} finally {
  rmSync(bundle, { force: true })
}
