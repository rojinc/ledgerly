// Bundles the tested backfill (functions/ledger/src/backfill-receipt-files.ts) the way the
// functions are bundled, together with the node-appwrite classes scripts/backfill-receipt-files.mjs
// uses. One copy of node-appwrite, so the backfill's `instanceof AppwriteException` checks see the
// errors the script's own clients throw.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

export async function bundleBackfill() {
  const { outputFiles } = await build({
    stdin: {
      contents: [
        "export { backfillReceiptFiles } from './functions/ledger/src/backfill-receipt-files.ts'",
        "export { AppwriteException, Client, Query, Storage, TablesDB } from 'node-appwrite'",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'backfill-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    target: 'es2022',
    format: 'esm',
    write: false,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  })
  // A fresh private directory, so nobody else on the machine can swap the bundle.
  const dir = mkdtempSync(join(tmpdir(), 'backfill-receipt-files-'))
  const file = join(dir, 'bundle.mjs')
  writeFileSync(file, outputFiles[0].text)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
