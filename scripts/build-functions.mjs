// Bundles Appwrite Functions into functions/<name>/dist/main.js, then checks that each bundle
// loads and answers GET /health. Usage: node scripts/build-functions.mjs [name ...] (default: all)
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const names = process.argv.slice(2)
const functions =
  names.length > 0
    ? names
    : readdirSync(`${root}/functions`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
const version = gitVersion()

for (const name of functions) {
  const outfile = `${root}/functions/${name}/dist/main.js`
  await build({
    entryPoints: [`${root}/functions/${name}/src/main.ts`],
    outfile,
    bundle: true, // every dependency goes in, so the deployment needs no npm install
    platform: 'node',
    target: 'es2022',
    format: 'esm',
    // Bundled CommonJS dependencies call require() for Node built-ins.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    define: {
      'process.env.LEDGERLY_VERSION': JSON.stringify(version),
      // ...and read __dirname, which ES modules don't have (pdfmake's in-memory file system).
      __dirname: 'import.meta.dirname',
      __filename: 'import.meta.filename',
    },
    logLevel: 'warning',
  })
  await checkHealth(name, outfile)
  console.log(`built functions/${name}/dist/main.js (${version})`)
}

// The commit the bundle was built from, so /health shows what is deployed; `-dirty` when the
// working tree had uncommitted changes.
function gitVersion() {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: root }).toString().trim()
  } catch {
    return 'local'
  }
}

async function checkHealth(name, outfile) {
  const { default: handler } = await import(pathToFileURL(outfile).href)
  let response
  await handler({
    req: { method: 'GET', path: '/health', headers: {}, bodyText: '' },
    res: { json: (body, status) => (response = { body, status }) },
    log: () => {},
    error: () => {},
  })
  if (response?.status !== 200 || response.body?.data?.fn !== name) {
    throw new Error(`functions/${name}: GET /health answered ${JSON.stringify(response)}`)
  }
}
