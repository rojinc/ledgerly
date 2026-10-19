// statements.md#invoice-pdf-layout-employer: the PDF fonts besides Roboto (#270). They are too
// big to bundle, so scripts/build-functions.mjs copies their files, checked by SHA-256, next to the
// bundle (functions/statements/dist/fonts/), and a file is read only when a text needs its font.
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PdfFont } from '@ledgerly/core/pdf/pdf-glyphs'
import { pdfmake, virtualfs } from './layout'

/** Each font's file. Regular only, so bold prints in it too: bold CJK would double the deploy. */
export const FONT_FILES: Record<Exclude<PdfFont, 'Roboto'>, string> = {
  NotoSansCJK: 'NotoSansCJKsc-Regular.otf',
  NotoEmoji: 'NotoEmoji_400Regular.ttf',
}

/** Reads a font file by its name. */
export type FontReader = (file: string) => Buffer

// In the bundle, import.meta.url is dist/main.js, so this is dist/fonts/.
const FOLDER = new URL('fonts/', import.meta.url)
let read: FontReader = (file) => readFileSync(new URL(file, FOLDER))
// What this instance has read, kept while it's warm.
const loaded = new Set<PdfFont>(['Roboto'])

// pdfmake reads a font's file from its in-memory file system only when a text uses the font.
pdfmake.addFonts(
  Object.fromEntries(
    Object.entries(FONT_FILES).map(([font, file]) => [font, { normal: file, bold: file }]),
  ),
)

/** Reads the file of each of `fonts` this instance hasn't read yet into pdfmake's file system. */
export function loadFonts(fonts: Iterable<PdfFont>): void {
  for (const font of fonts) {
    if (loaded.has(font)) continue
    const file = FONT_FILES[font as Exclude<PdfFont, 'Roboto'>]
    virtualfs.writeFileSync(file, read(file))
    loaded.add(font)
  }
}

/**
 * Throws if a font file isn't in `folder`, without reading it. The statements GET /health calls
 * it, so the build's check of each bundle proves the path with dist/fonts/ in place.
 */
export function checkFonts(folder = FOLDER): void {
  for (const file of Object.values(FONT_FILES)) {
    const url = new URL(file, folder)
    try {
      statSync(url)
    } catch (cause) {
      // Named, as the request log line gives only an error's name.
      const missing = new Error(`No font file at ${fileURLToPath(url)}`, { cause })
      missing.name = 'FontFileMissing'
      throw missing
    }
  }
}

/** For tests: read font files with `reader` from now on, as a new instance would. */
export function useFontReader(reader: FontReader): void {
  read = reader
  loaded.clear()
  loaded.add('Roboto')
}
