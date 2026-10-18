import type { GroupType, TransactionKind } from '../constants/domain'
import type { Shares } from '../generated/rows'

// ledger.md#reports: one person's reports, summed from their shares, one set per
// currency (ledger.md#currency). Callers fetch the shares; nothing here does I/O.

/** The share columns a report needs, including the copied ones (data-model.md#shares). */
export type ReportShare = Pick<
  Shares,
  'personId' | 'groupId' | 'date' | 'kind' | 'category' | 'givenCents' | 'receivedCents'
>

export type ReportGroup = { id: string; type: GroupType; currency: string }

export type PersonalReport = {
  currency: string
  spendingCents: number
  /**
   * Spending per category, with no category under `none`. Keys are in the order the
   * shares came in.
   */
  spendingByCategory: Record<string, number>
  earningsCents: number
  moneyReceivedCents: number
  incomeCents: number
  paidOutCents: number
  personalIncomeCents: number
}

export type MonthReport = { month: string; reports: PersonalReport[] }

const NO_CATEGORY = 'none'
const SPENDING_KINDS: ReadonlySet<string> = new Set<TransactionKind>(['expense', 'bill'])
const PAID_OUT_KINDS: ReadonlySet<string> = new Set<TransactionKind>([
  'expense',
  'bill',
  'payment',
  'loan',
])

function addShare(report: PersonalReport, share: ReportShare, groupType: GroupType): void {
  const { kind, givenCents, receivedCents } = share
  if (SPENDING_KINDS.has(kind)) {
    const category = share.category || NO_CATEGORY
    report.spendingCents += receivedCents
    report.spendingByCategory[category] = (report.spendingByCategory[category] ?? 0) + receivedCents
  }
  if (PAID_OUT_KINDS.has(kind)) report.paidOutCents += givenCents
  if (kind === 'shift') report.earningsCents += givenCents
  if (kind === 'payment') {
    report.moneyReceivedCents += receivedCents
    if (groupType === 'employer') report.incomeCents += receivedCents
  }
  // Σ receivedCents equals the income's totalCents by I-1, so no transaction rows
  // are needed.
  if (kind === 'income' && groupType === 'personal') {
    report.personalIncomeCents += receivedCents
    report.incomeCents += receivedCents
  }
}

/**
 * The reports for `personId` over `shares`, one per currency in which they have a
 * share, sorted by currency. A currency whose shares count toward no report (only
 * adjustments, say) gets an all-zero entry. Other people's shares are ignored. Every
 * share of `personId`'s needs its group in `groups`: dropping it silently would hide
 * money, so a missing group throws.
 */
export function buildPersonalReport(
  personId: string,
  shares: readonly ReportShare[],
  groups: readonly ReportGroup[],
): PersonalReport[] {
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const reports = new Map<string, PersonalReport>()
  for (const share of shares) {
    if (share.personId !== personId) continue
    const group = groupsById.get(share.groupId)
    if (!group) throw new RangeError("A share's group is missing from groups")
    let report = reports.get(group.currency)
    if (!report) {
      report = {
        currency: group.currency,
        spendingCents: 0,
        // No prototype, so a category named like `__proto__` is just another key.
        spendingByCategory: Object.create(null),
        earningsCents: 0,
        moneyReceivedCents: 0,
        incomeCents: 0,
        paidOutCents: 0,
        personalIncomeCents: 0,
      }
      reports.set(group.currency, report)
    }
    addShare(report, share, group.type)
  }
  return [...reports.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1))
}

/**
 * `buildPersonalReport` for each month with shares of `personId`, oldest first.
 * The month is the `YYYY-MM` of the local-date text, never a parsed Date, so the
 * machine's timezone can't move a share into another month.
 */
export function reportByMonth(
  personId: string,
  shares: readonly ReportShare[],
  groups: readonly ReportGroup[],
): MonthReport[] {
  const sharesByMonth = new Map<string, ReportShare[]>()
  for (const share of shares) {
    const month = share.date.slice(0, 7)
    const monthShares = sharesByMonth.get(month)
    if (monthShares) monthShares.push(share)
    else sharesByMonth.set(month, [share])
  }
  return [...sharesByMonth]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([month, monthShares]) => {
      const reports = buildPersonalReport(personId, monthShares, groups)
      return reports.length > 0 ? [{ month, reports }] : []
    })
}
