// Bundles the e2e mock (src/server.ts) as scripts/build-functions.mjs bundles a function, so it
// always runs this checkout's function code, and copies the statements PDF fonts next to it,
// where packages/server/src/pdf/fonts.ts reads them. `npm run test:e2e:mock -w @ledgerly/web`
// runs it first (docs/engineering/testing.md#on-the-mock).
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'dist')

await build({
  entryPoints: [join(here, 'src/server.ts')],
  outfile: join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  define: {
    'process.env.LEDGERLY_VERSION': JSON.stringify('mock'),
    // pdfmake's in-memory file system reads __dirname, which ES modules don't have.
    __dirname: 'import.meta.dirname',
    __filename: 'import.meta.filename',
  },
  logLevel: 'warning',
})

const fromServer = createRequire(join(here, '../server/package.json'))
mkdirSync(join(out, 'fonts'), { recursive: true })
for (const source of [
  join(here, '../server/fonts/NotoSansCJKsc-Regular.otf'),
  fromServer.resolve('@expo-google-fonts/noto-emoji/400Regular/NotoEmoji_400Regular.ttf'),
]) {
  copyFileSync(source, join(out, 'fonts', basename(source)))
}
