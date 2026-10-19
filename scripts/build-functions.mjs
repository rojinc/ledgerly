// Bundles Appwrite Functions into functions/<name>/dist/main.js, copies the files a bundle reads
// next to it, then checks that each bundle loads and answers GET /health.
// Usage: node scripts/build-functions.mjs [name ...] (default: all)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, relative } from 'node:path'
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
// The invoice PDF's Noto fonts (packages/server/src/pdf/fonts.ts), too big to bundle, with the
// SHA-256 of each pinned file (#270). A file that is missing or has changed fails the build.
// The emoji package is resolved from packages/server, whose devDependency it is: npm may not put
// it in the root node_modules.
const fromServer = createRequire(`${root}/packages/server/package.json`)
const fonts = {
  statements: [
    [
      `${root}/packages/server/fonts/NotoSansCJKsc-Regular.otf`,
      '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
    ],
    [
      fromServer.resolve('@expo-google-fonts/noto-emoji/400Regular/NotoEmoji_400Regular.ttf'),
      '24aaa2a20c9c06ffe9bf04284bfd1f14376a329d10122f902abe2770817eb504',
    ],
  ],
}

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
  copyFonts(name)
  await checkHealth(name, outfile)
  console.log(`built functions/${name}/dist/main.js (${version})`)
}

// The commit the bundle was built from, so /health shows what is deployed; `-dirty` when the
// working tree had uncommitted changes.
function gitVersion() {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'local'
  }
}

function copyFonts(name) {
  // Emptied first, so a font renamed or removed isn't deployed stale.
  rmSync(`${root}/functions/${name}/dist/fonts`, { recursive: true, force: true })
  for (const [source, sha256] of fonts[name] ?? []) {
    const path = relative(root, source)
    if (!existsSync(source)) throw new Error(`functions/${name}: ${path} is missing`)
    const content = readFileSync(source)
    const hash = createHash('sha256').update(content).digest('hex')
    if (hash !== sha256) {
      throw new Error(`functions/${name}: ${path} has SHA-256 ${hash}, not ${sha256}`)
    }
    mkdirSync(`${root}/functions/${name}/dist/fonts`, { recursive: true })
    writeFileSync(`${root}/functions/${name}/dist/fonts/${basename(source)}`, content)
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
