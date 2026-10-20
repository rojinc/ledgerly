import type { LocalDate } from '../dates/local-date'
import type { ChangeNets } from '../schemas/activity'

/** One `transaction.updated` or `transaction.voided` activity row with `nets`, parsed. */
export type ChangeRow = {
  transactionId: string
  actorPersonId: string
  voided: boolean
  nets: ChangeNets
  totalCents?: { before: number; after: number }
  date?: { before: LocalDate; after: LocalDate }
}

/** What one person is told about one transaction (scheduling.md#step-3b-transaction-change-emails). */
export type PersonChange = {
  transactionId: string
  /** Everyone else who changed it in the window, in the order they first did. */
  changedBy: string[]
  totalCents: { before: number; after: number }
  date: { before: LocalDate; after: LocalDate }
  /** Their own net in it, before and after; `after` is 0 once it's voided. */
  netCents: { before: number; after: number }
  voided: boolean
}

/**
 * Folds a window's rows, in `at` order, into what each person is told: per transaction, the first
 * `before` and the last `after` of each field, the total and the date from the rows that changed
 * them or else `current`, and each person's net summed over the entries that name them once
 * `personOf` has followed merges. Someone hears about a transaction only when someone else changed
 * it and their net, the total or the date differs, or it was voided.
 */
export function transactionChanges(
  rows: readonly ChangeRow[],
  current: (transactionId: string) => { totalCents: number; date: LocalDate },
  personOf: (personId: string) => string,
): Map<string, PersonChange[]> {
  const byTransaction = new Map<string, ChangeRow[]>()
  for (const row of rows) {
    const list = byTransaction.get(row.transactionId)
    if (list) list.push(row)
    else byTransaction.set(row.transactionId, [row])
  }
  const told = new Map<string, PersonChange[]>()
  for (const [transactionId, list] of byTransaction) {
    const first = list[0] as ChangeRow
    const last = list[list.length - 1] as ChangeRow
    const now = current(transactionId)
    const totalCents = folded(list, (row) => row.totalCents, now.totalCents)
    const date = folded(list, (row) => row.date, now.date)
    const voided = list.some((row) => row.voided)
    const actors = [...new Set(list.map((row) => personOf(row.actorPersonId)))]
    const before = summed(first.nets.before, personOf)
    const after = summed(last.nets.after, personOf)
    for (const personId of new Set([...before.keys(), ...after.keys()])) {
      const changedBy = actors.filter((actor) => actor !== personId)
      const netCents = { before: before.get(personId) ?? 0, after: after.get(personId) ?? 0 }
      const differs =
        voided ||
        netCents.before !== netCents.after ||
        totalCents.before !== totalCents.after ||
        date.before !== date.after
      if (changedBy.length === 0 || !differs) continue
      const change = { transactionId, changedBy, totalCents, date, netCents, voided }
      const changes = told.get(personId)
      if (changes) changes.push(change)
      else told.set(personId, [change])
    }
  }
  return told
}

/** The first `before` and the last `after` among the rows that changed a field, or `now`'s. */
function folded<T>(
  rows: readonly ChangeRow[],
  field: (row: ChangeRow) => { before: T; after: T } | undefined,
  now: T,
): { before: T; after: T } {
  const changes = rows.flatMap((row) => field(row) ?? [])
  return { before: changes[0]?.before ?? now, after: changes.at(-1)?.after ?? now }
}

function summed(
  nets: ChangeNets['before'],
  personOf: (personId: string) => string,
): Map<string, number> {
  const sums = new Map<string, number>()
  for (const { personId, netCents } of nets) {
    const person = personOf(personId)
    sums.set(person, (sums.get(person) ?? 0) + netCents)
  }
  return sums
}
