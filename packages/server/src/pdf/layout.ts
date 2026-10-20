/// <reference path="./linebreak.d.ts" />
import type { fontRuns, PdfFont } from '@ledgerly/core/pdf/pdf-glyphs'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import LineBreaker from 'linebreak'
import pdfmake from 'pdfmake'
import vfs from 'pdfmake/build/vfs_fonts.js'
import type {
  Content,
  ContentStack,
  ContentText,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces'

// Roboto ships inside pdfmake as base64 in a JavaScript file, so esbuild bundles it like any
// other module and the function needs no font files on disk. In Node, pdfmake takes fonts only
// by file name, so they go into its in-memory file system (not in its types), as fonts.ts's do.
export const { virtualfs } = pdfmake as unknown as {
  virtualfs: { writeFileSync(name: string, content: Buffer): void }
}
const fonts = { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf' }
for (const file of Object.values(fonts)) {
  virtualfs.writeFileSync(file, Buffer.from(vfs[file] as string, 'base64'))
}
pdfmake.setFonts({ Roboto: fonts })
// A statement PDF uses only the data passed in: never fetch a URL or read a local file.
pdfmake.setUrlAccessPolicy(() => false)
pdfmake.setLocalAccessPolicy(() => false)

export { pdfmake }

export const LOCALE = 'en-AU'
export const MUTED = '#616e7c'
// For lines with no description. `kind` is a plain string in old snapshots, so unknown ones print as is.
const KIND_LABELS: Record<string, string> = {
  shift: 'Shift',
  expense: 'Expense',
  bill: 'Bill',
  payment: 'Payment',
  loan: 'Loan',
  income: 'Income',
  adjustment: 'Adjustment',
}

export type Line = StatementSnapshot['lines'][number]
/** A text in one font, as `fontRuns()` splits it. */
export type FontRun = ReturnType<typeof fontRuns>[number]

/** The page, fonts and styles every statement PDF shares. */
export const PAGE: Omit<TDocumentDefinitions, 'content'> = {
  pageSize: 'A4',
  pageMargins: [40, 40, 40, 50],
  defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.15 },
  styles: {
    issuer: { fontSize: 14, bold: true, margin: [0, 0, 0, 4] },
    title: { fontSize: 20, bold: true, alignment: 'right', margin: [0, 0, 0, 6] },
    heading: { fontSize: 12, bold: true, margin: [0, 14, 0, 4] },
    balance: { fontSize: 14, bold: true },
  },
  // A heading never ends a page: it moves to the next page with what follows it.
  pageBreakBefore: (node, nodes) =>
    node.headlineLevel === 1 && nodes.getFollowingNodesOnPage().length === 0,
}

/** The page footer: `<label> · page 2 of 3`. */
export function footer(label: Content): TDocumentDefinitions['footer'] {
  return (page, pages) => ({
    // In its own text: pdfmake would take a bare array of runs for a stack and leave it out.
    text: [{ text: label }, ` · page ${page} of ${pages}`],
    alignment: 'center',
    fontSize: 8,
    color: MUTED,
  })
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// A word pdfmake can't break widens its column until the amounts fall off the page, so long
// runs without a space (a pasted reference or URL) get a zero-width space every 20 characters.
// Counted as a reader sees them (grapheme clusters), so it never cuts an emoji, a flag or a
// letter and its mark apart: half an emoji prints as �.
export function breakable(text: string): string {
  let word = 0
  let broken = ''
  for (const { segment } of graphemes.segment(text)) {
    if (/\s/.test(segment)) word = 0
    else if (++word > 20) {
      broken += '\u200B'
      word = 1
    }
    broken += segment
  }
  return broken
}

// Each font's widest character at 10 pt (Roboto's medium Ѹ, Noto Sans CJK's ⸻, and any of Noto
// Emoji's), read from the files: no word pdfmake measures is wider than these say.
const WIDEST: Record<PdfFont, number> = { Roboto: 11.79, NotoSansCJK: 24.59, NotoEmoji: 12.7 }
const LINE_END = /\r?\n$|\r$/

// A line break takes no width: it ends the line.
export const widthOf = (font: PdfFont, text: string) =>
  [...text.replace(/[\r\n]/g, '')].length * WIDEST[font]

/** Where `linebreak` (UAX #14), which pdfmake splits words with, allows a break in `text`. */
function breaks(text: string): { position: number; required: boolean }[] {
  const breaker = new LineBreaker(text)
  const found = []
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) found.push(next)
  return found
}

/**
 * One run's words, as pdfmake's `splitWords()` makes them (pdfmake/js/TextBreaker.js): `text`
 * without the line break that ends it, which `raw` keeps.
 */
function splitWords(text: string): { text: string; raw: string; lineEnd: boolean }[] {
  if (text === '') return [{ text, raw: text, lineEnd: false }]
  let start = 0
  return breaks(text).map(({ position, required }) => {
    const raw = text.slice(start, position)
    start = position
    const lineEnd = required || LINE_END.test(raw)
    return { text: lineEnd ? raw.replace(LINE_END, '') : raw, raw, lineEnd }
  })
}

export type Word = { font: PdfFont; text: string; raw: string; glued: boolean; lineEnd: boolean }

/**
 * The words pdfmake lays `runs` out in, as its `TextBreaker` makes them: each run split on its
 * own, and a run's last word glued to the next run's first when the two have no break between
 * them. pdfmake keeps glued words on one line where they fit, and fills lines with them a
 * character at a time where they don't.
 */
export function pdfWords(runs: readonly FontRun[]): Word[] {
  const words: Word[] = []
  let last: string | undefined
  runs.forEach(({ font, text }, index) => {
    const split = splitWords(text)
    const previous = words.at(-1)
    if (last && previous && splitWords(last + split[0]?.text).length === 1) previous.glued = true
    for (const word of split) words.push({ font, ...word, glued: false })
    const end = split.at(-1)
    last = index + 1 < runs.length && !end?.lineEnd ? end?.text : undefined
  })
  return words
}

/**
 * `runs` with a zero-width space wherever a word, or words pdfmake glues together, would print
 * wider than `width` (a column's, in pt), at their fonts' widest. pdfmake widens a column to its widest word, and
 * never cuts a glued piece of one character, so either way a longer one runs into the amounts or
 * pushes them off the page. breakable() can't see that: it counts the text as typed, but a Thai
 * letter prints as one `�` or more, a space pdfmake doesn't break at (a tab, say) prints as `�`,
 * and a run in another font can glue to the next. The space goes between grapheme clusters, so it
 * never cuts an emoji apart, unless one cluster is wider than the column (emoji joined by U+200D,
 * say), and in Roboto, which has it.
 */
export function narrow(runs: readonly FontRun[], width: number): FontRun[] {
  const narrowed: FontRun[] = []
  const add = (font: PdfFont, text: string) => {
    const last = narrowed.at(-1)
    if (last?.font === font) last.text += text
    else if (text !== '') narrowed.push({ font, text })
  }
  let used = 0
  for (const { font, raw, glued } of pdfWords(runs)) {
    for (const { segment } of graphemes.segment(raw)) {
      for (const piece of widthOf(font, segment) > width ? segment : [segment]) {
        const char = widthOf(font, piece)
        if (used + char > width) {
          add('Roboto', '\u200B')
          used = 0
        }
        add(font, piece)
        used += char
      }
    }
    if (!glued) used = 0
  }
  return narrowed
}

export function lineText(line: Line): string {
  return breakable(line.description || KIND_LABELS[line.kind] || line.kind)
}

export function heading(text: string): Content {
  return { text, style: 'heading', headlineLevel: 1 }
}

/** A table cell: text, styled text, or a stack of them. */
export type Cell = string | ContentText | ContentStack

/**
 * A table of text columns, then numbers from column `numbersFrom` on (counted from 0; default 2),
 * which are right-aligned.
 */
export function table(
  widths: (number | string)[],
  header: string[],
  rows: Cell[][],
  {
    total,
    numbersFrom = 2,
  }: { total?: [label: string, amount: string]; numbersFrom?: number } = {},
): Content {
  const row = (cells: Cell[], style: { bold?: boolean; color?: string } = {}): TableCell[] =>
    cells.map(
      (cell, index) =>
        ({
          ...(typeof cell === 'string' ? { text: cell } : cell),
          ...style,
          alignment: index >= numbersFrom ? 'right' : 'left',
        }) as TableCell,
    )
  const body = [row(header, { bold: true, color: MUTED }), ...rows.map((cells) => row(cells))]
  if (total) {
    // A spanned cell still needs its empty placeholders.
    body.push([
      { text: total[0], bold: true, colSpan: widths.length - 1 },
      ...Array.from({ length: widths.length - 2 }, () => ({})),
      { text: total[1], bold: true, alignment: 'right' },
    ])
  }
  return { layout: 'lightHorizontalLines', table: { headerRows: 1, widths, body } }
}

export function field(label: string, value: Content): TableCell[] {
  return [
    { text: label, color: MUTED },
    { text: value, bold: true },
  ]
}

/** `16 Oct 2026`, read from the `YYYY-MM-DD` parts and shown in UTC, so it never shifts a day. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(Date.UTC(year, month - 1, day))
}
