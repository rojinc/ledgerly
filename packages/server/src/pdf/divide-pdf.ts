import { formatMoney } from '@ledgerly/core/money/format'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import type {
  Content,
  ContentText,
  CustomTableLayout,
  TDocumentDefinitions,
} from 'pdfmake/interfaces'
import {
  breakable,
  field,
  footer,
  formatDate,
  heading,
  type Line,
  LOCALE,
  lineText,
  MUTED,
  PAGE,
  pdfmake,
  table,
} from './layout'

// Wide enough for -$1,234,567.89 on one line.
const AMOUNT = 70

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
        { text: breakable(snapshot.group.name), style: 'issuer' },
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
        nameOf(person.personId),
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
      ? snapshot.transfers.map(
          (transfer) =>
            `${nameOf(transfer.fromPersonId)} pays ${nameOf(transfer.toPersonId)} ${money(transfer.cents).text}`,
        )
      : ['Everyone is settled up.']),
  ]
  if (snapshot.lines.length > 0) content.push(transactions(snapshot, money, nameOf))

  const doc: TDocumentDefinitions = {
    ...PAGE,
    info: { title: `Divide ${period}`, creator: 'Ledgerly', producer: 'Ledgerly' },
    footer: footer(`Divide ${period}`),
    content,
  }
  return pdfmake.createPdf(doc).getBuffer()
}

// pdfmake drops the part of a row it may not break that doesn't fit on one page, so rows are
// kept whole only while every one surely fits: at most this many wrapped lines (about 700 pt of
// a page), counting a line per 10 characters, which no name or description in Roboto 10 pt beats,
// from each line break.
const MAX_ROW_LINES = 45
const CHARS_PER_LINE = 10
// Where pdfmake must start a new line (Unicode's mandatory breaks; CR LF counts twice, which is
// safe). A stored
// name or description can hold them.
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/

function wrappedLines(line: Line, nameOf: (personId: string) => string): number {
  const lines = (text: string) =>
    text
      .split(LINE_BREAK)
      .reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / CHARS_PER_LINE)), 0)
  return line.shares.reduce(
    (sum, share) => sum + lines(nameOf(share.personId)),
    lines(lineText(line)),
  )
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
): Content {
  // A row too tall for a page breaks across pages rather than vanish, heading and all.
  const whole = snapshot.lines.every((line) => wrappedLines(line, nameOf) <= MAX_ROW_LINES)
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
        ...snapshot.lines.map((line) => [
          formatDate(line.date),
          {
            colSpan: 3,
            layout: NESTED,
            table: {
              widths: ['*', AMOUNT, AMOUNT],
              body: [
                [{ text: lineText(line), bold: true }, '', ''],
                ...line.shares.map((share) => [
                  { text: nameOf(share.personId), color: MUTED, margin: [10, 0, 0, 0] },
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
