import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
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
// by file name, so they go into its in-memory file system (not in its types).
const { virtualfs } = pdfmake as unknown as {
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
export function footer(label: string): TDocumentDefinitions['footer'] {
  return (page, pages) => ({
    text: `${label} · page ${page} of ${pages}`,
    alignment: 'center',
    fontSize: 8,
    color: MUTED,
  })
}

// A word pdfmake can't break widens its column until the amounts fall off the page, so long
// runs without a space (a pasted reference or URL) get a zero-width space every 20 characters.
export function breakable(text: string): string {
  return text.replace(/\S{20}(?=\S)/g, '$&\u200B')
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
 * A table of text columns, then numbers from column `numbersFrom` (default 2) on, which are
 * right-aligned.
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

export function field(label: string, value: string): TableCell[] {
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
