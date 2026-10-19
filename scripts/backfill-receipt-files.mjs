// One-off for #163: adds every transaction that lists a receipt to its receiptFiles row, for files
// attached before the ledger kept these rows (data-model.md#receiptfiles). Run it once in each
// environment, after the ledger change is deployed and before scheduler step 5 is:
//   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node scripts/backfill-receipt-files.mjs
// The key needs rows.read and rows.write. It prints counts only. Safe to run again.
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Client, TablesDB } from 'node-appwrite'

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
  console.log(await backfillReceiptFiles(new TablesDB(client)))
} finally {
  rmSync(bundle, { force: true })
}
