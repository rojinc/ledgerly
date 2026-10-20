/// <reference path="./linebreak.d.ts" />
import { formatMoney } from '@ledgerly/core/money/format'
import { fontRuns, missingGlyphs, type PdfFont } from '@ledgerly/core/pdf/pdf-glyphs'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import LineBreaker from 'linebreak'
import type {
  Content,
  ContentText,
  CustomTableLayout,
  TDocumentDefinitions,
} from 'pdfmake/interfaces'
import { logProblem } from '../http/log'
import { loadFonts } from './fonts'
import {
  breakable,
  field,
  footer,
  formatDate,
  heading,
  LOCALE,
  lineText,
  MUTED,
  PAGE,
  pdfmake,
  table,
} from './layout'

type FontRun = ReturnType<typeof fontRuns>[number]

// Wide enough for -$1,234,567.89 on one line.
const AMOUNT = 70
// Unicode's mandatory breaks other than a line feed or carriage return, which a stored name or
// description can hold (#346). No font has them, so they'd print as �, which pdfmake doesn't break
// at, and breakable() takes them for spaces: a name of them would widen its column until the
// amounts fall off the page. They print as line feeds instead, so pdfmake breaks there.
const OTHER_BREAKS = /[\v\f\u0085\u2028\u2029]/g

/**
 * The house divide PDF, laid out as statements.md#monthly-divide-pdf-layout-house says: who
 * paid what, everyone's share and who should pay whom. It's never called an invoice and has
 * no GST.
 */
export async function renderDividePdf(snapshot: StatementSnapshot): Promise<Buffer> {
  if (snapshot.group.type !== 'house') throw new Error('renderDividePdf needs a house snapshot')
  const money = (cents: number): ContentText => ({
    text: formatMoney(cents, snapshot.group.currency, LOCALE),
    noWrap: true,
  })
  // As the invoice does (invoice-pdf.ts): every text from the snapshot prints as fontRuns()
  // splits it, each run in its own font, and a character no font has as �. A font's file is read
  // the first time a run needs it.
  let replaced = 0
  const print = (text: string): FontRun[] => {
    const shown = text.replace(OTHER_BREAKS, '\n')
    replaced += missingGlyphs(shown).length
    const runs = narrow(fontRuns(shown))
    loadFonts(runs.map((run) => run.font))
    return runs
  }
  const names = new Map(snapshot.people.map((person) => [person.personId, breakable(person.name)]))
  // buildStatementSnapshot lists everyone in a line or a transfer in `people`.
  const nameOf = (personId: string): string => {
    const name = names.get(personId)
    if (name === undefined) throw new Error('A divide names only the people in its snapshot')
    return name
  }
  const period = `${formatDate(snapshot.period.start)} – ${formatDate(snapshot.period.end)}`
  // In words too, so the sign isn't the only thing that says who owes.
  const standing = (closingCents: number) =>
    closingCents > 0
      ? `is owed ${money(closingCents).text}`
      : closingCents < 0
        ? `owes ${money(-closingCents).text}`
        : 'settled'

  const content: Content[] = [
    {
      columns: [
        { text: print(breakable(snapshot.group.name)), style: 'issuer' },
        {
          width: 'auto',
          stack: [
            { text: 'Divide', style: 'title' },
            { layout: 'noBorders', table: { body: [field('Period', period)] } },
          ],
        },
      ],
    },
    heading('People'),
    table(
      ['*', AMOUNT, AMOUNT, AMOUNT, 90],
      ['Name', 'Opening', 'Paid', 'Share', 'Closing'],
      snapshot.people.map((person) => [
        { text: print(nameOf(person.personId)) },
        money(person.openingCents),
        money(person.givenCents),
        money(person.receivedCents),
        {
          stack: [
            money(person.closingCents),
            { text: standing(person.closingCents), fontSize: 8, color: MUTED },
          ],
        },
      ]),
      { numbersFrom: 1 },
    ),
    heading('Suggested transfers'),
    ...(snapshot.transfers.length > 0
      ? snapshot.transfers.map((transfer) => ({
          text: print(
            `${nameOf(transfer.fromPersonId)} pays ${nameOf(transfer.toPersonId)} ${money(transfer.cents).text}`,
          ),
        }))
      : ['Everyone is settled up.']),
  ]
  if (snapshot.lines.length > 0) content.push(transactions(snapshot, money, nameOf, print))
  // The count only, never the text (security-and-privacy.md#personal-data).
  if (replaced > 0) logProblem('pdf_characters_replaced', { count: replaced })

  const doc: TDocumentDefinitions = {
    ...PAGE,
    info: { title: `Divide ${period}`, creator: 'Ledgerly', producer: 'Ledgerly' },
    footer: footer(`Divide ${period}`),
    content,
  }
  return pdfmake.createPdf(doc).getBuffer()
}

// pdfmake keeps only the first page of a row it may not break, so a row taller than a page
// loses the rest, and near a page's height the whole table can go, heading and all, without an
// error (#300). So rows are kept whole only while every one surely fits: at most this many lines
// of Roboto's height (13.48 pt), which with 15 people's row padding (64 pt) leaves about 25 pt of
// the 696 pt under the table's headers.
const MAX_ROW_LINES = 45
// The narrowest cell a row's text wraps in: a person's name, set 10 pt into the description's.
// Every other text the divide prints has a wider one.
const CELL_WIDTH = 171
// Each font's widest character at 10 pt (Roboto's medium Ѹ, Noto Sans CJK's ⸻, and any of Noto
// Emoji's), read from the files: no word pdfmake measures is wider than these say.
const WIDEST: Record<PdfFont, number> = { Roboto: 11.79, NotoSansCJK: 24.59, NotoEmoji: 12.7 }
// A line with any Noto Sans CJK is its 1.448 em tall, against 1.172 for Roboto and Noto Emoji:
// 1.24 times, rounded up.
const CJK_LINE = 1.25
const LINE_END = /\r?\n$|\r$/

const widthOf = (font: PdfFont, text: string) => [...text].length * WIDEST[font]
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Where `linebreak` (UAX #14), which pdfmake splits words with, allows a break in `text`. */
function breaks(text: string): { position: number; required: boolean }[] {
  const breaker = new LineBreaker(text)
  const found = []
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) found.push(next)
  return found
}

/** One run's words, as pdfmake's `splitWords()` makes them (pdfmake/js/TextBreaker.js). */
function splitWords(text: string): { text: string; lineEnd: boolean }[] {
  if (text === '') return [{ text, lineEnd: false }]
  let start = 0
  return breaks(text).map(({ position, required }) => {
    const word = text.slice(start, position)
    start = position
    const lineEnd = required || LINE_END.test(word)
    return { text: lineEnd ? word.replace(LINE_END, '') : word, lineEnd }
  })
}

type Word = { font: PdfFont; text: string; glued: boolean; lineEnd: boolean }

/**
 * The words pdfmake lays `runs` out in, as its `TextBreaker` makes them: each run split on its
 * own, and a run's last word glued to the next run's first when the two have no break between
 * them. pdfmake keeps glued words on one line where they fit, and fills lines with them a
 * character at a time where they don't.
 */
function pdfWords(runs: readonly FontRun[]): Word[] {
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
 * `runs` with a zero-width space wherever a word would print wider than CELL_WIDTH, at its fonts'
 * widest. pdfmake widens a column to its widest word, so a longer one pushes the amounts off the
 * page. breakable() can't see that: it counts the text as typed, but a Thai letter prints as one
 * `�` or more, and a space pdfmake doesn't break at (a tab, say) prints as `�`. The space goes
 * between grapheme clusters, so it never cuts an emoji apart, and in Roboto, which has it.
 */
function narrow(runs: readonly FontRun[]): FontRun[] {
  const narrowed: FontRun[] = []
  const add = (font: PdfFont, text: string) => {
    const last = narrowed.at(-1)
    if (last?.font === font) last.text += text
    else if (text !== '') narrowed.push({ font, text })
  }
  for (const { font, text } of runs) {
    let start = 0
    for (const { position } of breaks(text)) {
      const word = text.slice(start, position)
      start = position
      if (widthOf(font, word) <= CELL_WIDTH) {
        add(font, word)
        continue
      }
      let width = 0
      for (const { segment } of graphemes.segment(word)) {
        const char = widthOf(font, segment)
        if (width > 0 && width + char > CELL_WIDTH) {
          add('Roboto', '\u200B')
          width = 0
        }
        add(font, segment)
        width += char
      }
    }
  }
  return narrowed
}

/**
 * The most lines of Roboto's height that `runs`, as printed, can take in a cell CELL_WIDTH wide.
 * It wraps pdfmake's own words (pdfWords()) greedily, as pdfmake does, with every character as
 * wide as its font's widest, and glued words as one; a required break starts a new line.
 *
 * A word wider than the cell starts a new line, and the next word starts another. pdfmake breaks
 * it where Unicode allows, or between characters, packing whole pieces, so any two of its lines
 * together hold more than a cell: it takes at most 1 + 2 × width / CELL_WIDTH lines, wherever the
 * pieces fall.
 */
export function wrappedLines(runs: readonly FontRun[]): number {
  let lines = 1
  let x = 0
  let width = 0
  const words = pdfWords(runs)
  words.forEach((word, index) => {
    width += widthOf(word.font, word.text)
    if (word.glued) return
    if (width <= CELL_WIDTH) {
      if (x > 0 && x + width > CELL_WIDTH) {
        lines++
        x = 0
      }
      x += width
    } else {
      if (x > 0) lines++
      lines += Math.floor((2 * width) / CELL_WIDTH)
      x = CELL_WIDTH
    }
    width = 0
    if (word.lineEnd && index + 1 < words.length) {
      lines++
      x = 0
    }
  })
  return runs.some((run) => run.font === 'NotoSansCJK') ? lines * CJK_LINE : lines
}

// The outer table's padding, so the amounts under a line sit under the Paid and Share headers.
const NESTED: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: (index) => (index === 0 ? 0 : 8),
  paddingRight: (index, node) => (index === (node.table.widths?.length ?? 0) - 1 ? 0 : 8),
}

/**
 * Each transaction is one row, with its people in a table of their own under the description,
 * so a page never breaks inside one, unless a line is too tall for any page. The heading is the
 * table's first header row, so it's never left alone at the foot of a page; it repeats on each
 * page the table runs onto.
 */
function transactions(
  snapshot: StatementSnapshot,
  money: (cents: number) => ContentText,
  nameOf: (personId: string) => string,
  print: (text: string) => FontRun[],
): Content {
  const rows = snapshot.lines.map((line) => ({
    line,
    description: print(lineText(line)),
    names: line.shares.map((share) => print(nameOf(share.personId))),
  }))
  // A row too tall for a page breaks across pages rather than vanish, heading and all.
  const whole = rows.every(
    ({ description, names }) =>
      names.reduce((sum, name) => sum + wrappedLines(name), wrappedLines(description)) <=
      MAX_ROW_LINES,
  )
  const right = (cell: ContentText): ContentText => ({ ...cell, alignment: 'right' })
  const header = ['Date', 'Description', 'Paid', 'Share', 'Total'].map((text, index) => ({
    text,
    bold: true,
    color: MUTED,
    alignment: index >= 2 ? 'right' : 'left',
  }))
  return {
    layout: 'lightHorizontalLines',
    table: {
      headerRows: 2,
      keepWithHeaderRows: whole ? 1 : 0,
      dontBreakRows: whole,
      widths: [60, '*', AMOUNT, AMOUNT, AMOUNT],
      body: [
        [{ text: 'Transactions', style: 'heading', colSpan: 5 }, {}, {}, {}, {}],
        header,
        ...rows.map(({ line, description, names }) => [
          formatDate(line.date),
          {
            colSpan: 3,
            layout: NESTED,
            table: {
              widths: ['*', AMOUNT, AMOUNT],
              body: [
                [{ text: description, bold: true }, '', ''],
                ...line.shares.map((share, index) => [
                  { text: names[index], color: MUTED, margin: [10, 0, 0, 0] },
                  right(money(share.givenCents)),
                  right(money(share.receivedCents)),
                ]),
              ],
            },
          },
          {},
          {},
          right(money(line.totalCents)),
        ]),
      ],
    },
  } as Content
}
