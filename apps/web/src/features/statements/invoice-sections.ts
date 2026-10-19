import { type StatementSnapshot, statementSnapshotSchema } from '@ledgerly/core/schemas/statements'

export type Line = StatementSnapshot['lines'][number]

/** A statement's stored snapshot, or undefined when it can't be read. */
export function readSnapshot(json: string): StatementSnapshot | undefined {
  try {
    const parsed = statementSnapshotSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export type InvoiceSections = {
  openingCents: number
  /** What each line adds to or takes off the balance due. */
  owed: (line: Line) => number
  charges: Line[]
  credits: Line[]
  /** Lines that don't change the balance, such as purchases on the employer's card. */
  records: Line[]
}

/**
 * The invoice's lines sorted the way the PDF sorts them (packages/server/src/pdf/invoice-pdf.ts,
 * statements.md#invoice-pdf-layout-employer): what each changes in the worker's balance, their
 * given minus received, decides whether it's a charge, a payment or deduction, or only a record.
 */
export function invoiceSections(snapshot: StatementSnapshot, workerId: string): InvoiceSections {
  const owed = (line: Line) =>
    line.shares
      .filter((share) => share.personId === workerId)
      .reduce((sum, share) => sum + share.givenCents - share.receivedCents, 0)
  const worker = snapshot.people.find((person) => person.personId === workerId)
  return {
    openingCents: worker?.openingCents ?? 0,
    owed,
    charges: snapshot.lines.filter((line) => owed(line) > 0),
    credits: snapshot.lines.filter((line) => owed(line) < 0),
    records: snapshot.lines.filter((line) => owed(line) === 0),
  }
}
