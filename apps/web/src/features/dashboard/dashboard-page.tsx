import { endOfMonth, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import {
  type MonthReport,
  type PersonalReport,
  reportByMonth,
} from '@ledgerly/core/reports/personal-report'
import { type ReactNode, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { type Month, monthOf, parseMonth, shiftMonth } from '../calendar/month-grid'
import { GroupName } from '../groups/use-group-name'
import { useGroups } from '../groups/use-groups'
import { GettingStarted } from '../onboarding/getting-started'
import { useProfile } from '../profile/use-profile'
import { HoursCapSummary } from '../shifts/hours-cap'
import { useAllBalances, useMyShares } from './use-dashboard'

const TYPE_LABEL: Record<Groups['type'], string> = {
  personal: 'Personal',
  employer: 'Employer',
  house: 'House',
  pair: 'Shared with one person',
}

const HISTORY_MONTHS = 6

// A month in words; UTC on both sides, so the browser's zone never moves it.
function formatMonth(month: Month, style: 'long' | 'short'): string {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  return new Intl.DateTimeFormat(undefined, {
    month: style,
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(year, monthNumber - 1, 1))
}

function categoryLabel(category: string): string {
  return category === 'none' ? 'No category' : `${category[0]?.toUpperCase()}${category.slice(1)}`
}

/** `/`: what the user is owed and owes in every group, and a month of spending and income (#79). */
export function DashboardPage() {
  const user = useCurrentUser().data
  const groups = useGroups()
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <div className="flex flex-col gap-8">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        Hi{user?.name ? `, ${user.name}` : ''}
      </h1>
      {groups.data ? (
        <>
          <GettingStarted groups={groups.data} focusHeading={() => heading.current?.focus()} />
          {/* No groups: nothing to sum yet, only the guide. */}
          {groups.data.length > 0 && (
            <>
              <HoursCapSummary />
              <BalancesSection groups={groups.data} />
              <MonthSections groups={groups.data} refetchGroups={() => groups.refetch()} />
            </>
          )}
        </>
      ) : groups.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-destructive">
            We couldn’t load your groups.
          </p>
          <Button variant="outline" onClick={() => groups.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      )}
    </div>
  )
}

function balanceText(net: number, currency: string): string {
  const amount = formatMoney(Math.abs(net), currency)
  return net > 0 ? `Owed ${amount}` : net < 0 ? `You owe ${amount}` : 'Settled'
}

/** One row per group with the user's balance, and the totals per currency once all have loaded. */
function BalancesSection({ groups }: { groups: Groups[] }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const balances = useAllBalances(groups)
  const nets = balances.map((balance) =>
    balance.data && personId !== ''
      ? (balance.data.people.find((person) => person.personId === personId)?.netCents ?? 0)
      : undefined,
  )

  // Per currency, never across them (ledger.md#currency). Sorted by currency.
  const totals = new Map<string, { owed: number; owe: number }>()
  for (const [index, group] of groups.entries()) {
    const net = nets[index] ?? 0
    const total = totals.get(group.currency) ?? { owed: 0, owe: 0 }
    if (net > 0) total.owed += net
    else total.owe -= net
    totals.set(group.currency, total)
  }
  const allLoaded = nets.every((net) => net !== undefined)

  return (
    <section aria-labelledby="balances-heading" className="flex flex-col gap-3">
      <h2 id="balances-heading" className="text-lg font-medium">
        Owed to me / I owe
      </h2>
      <ul className="divide-y divide-border rounded-md border border-border">
        {groups.map((group, index) => (
          <li key={group.$id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium break-words">
                <GroupName group={group} />
              </p>
              <p className="text-sm text-muted-foreground">
                {TYPE_LABEL[group.type]}
                {group.archivedAt ? ' · Archived' : ''}
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium">
              {nets[index] !== undefined ? (
                balanceText(nets[index], group.currency)
              ) : balances[index]?.isError ? (
                <span className="text-muted-foreground">Balance not available yet</span>
              ) : (
                <span className="text-muted-foreground">
                  <span aria-hidden="true">…</span>
                  <span className="sr-only">Loading balance</span>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {allLoaded ? (
        <dl className="flex flex-col gap-1 text-sm">
          {[...totals]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([currency, total]) => (
              <div key={currency} className="flex flex-wrap gap-x-2">
                <dt className="font-medium">Total in {currency}:</dt>
                <dd>
                  owed to you {formatMoney(total.owed, currency)} · you owe{' '}
                  {formatMoney(total.owe, currency)}
                </dd>
              </div>
            ))}
        </dl>
      ) : (
        balances.some((balance) => balance.isError) && (
          <p className="text-sm text-muted-foreground">
            Totals show once every group’s balance has loaded.
          </p>
        )
      )}
    </section>
  )
}

/**
 * The months on screen: the last 6 up to this month, or up to the chosen month when that's
 * outside them, so the chosen month is always one of them.
 */
function monthsShown(chosen: Month, current: Month): Month[] {
  const last = chosen <= current && chosen > shiftMonth(current, -HISTORY_MONTHS) ? current : chosen
  return Array.from({ length: HISTORY_MONTHS }, (_, index) =>
    shiftMonth(last, index + 1 - HISTORY_MONTHS),
  )
}

/** This month's report and the last 6 months, both from the user's own shares (ledger.md#reports). */
function MonthSections({ groups, refetchGroups }: { groups: Groups[]; refetchGroups: () => void }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const profile = useProfile(userId)
  // The profile's zone; the browser's if the profile can't be read, rather than loading forever.
  const timeZone =
    profile.data?.timezone ??
    (profile.isError ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined)
  const [params, setParams] = useSearchParams()
  const current = timeZone ? monthOf(localToday(timeZone, new Date())) : undefined
  // Years before 100 are left out: Date.UTC would read them as 19xx.
  const asked = parseMonth(params.get('month'))
  const month = (asked && asked >= '0100' ? asked : undefined) ?? current
  const months = month && current ? monthsShown(month, current) : []
  const first = months[0]
  const last = months.at(-1)
  // Empty until the zone is known; the query waits for it.
  const start = (first ? `${first}-01` : '') as LocalDate
  const end = last ? endOfMonth(`${last}-01` as LocalDate) : start
  const shares = useMyShares(first ? personId : '', start, end)

  if (!month || !current) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  }

  const select = (next: Month) => setParams({ month: next })
  // The header and its buttons stay mounted while a new 6 months load, so focus stays on them.
  let body: ReactNode
  let history: ReactNode = null
  if (!shares.data) {
    body = shares.isError ? (
      <LoadError onRetry={() => shares.refetch()} />
    ) : (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  } else {
    let reports: MonthReport[] | undefined
    try {
      reports = reportByMonth(
        personId,
        shares.data,
        groups.map((group) => ({ id: group.$id, type: group.type, currency: group.currency })),
      )
    } catch (error) {
      // A share in a group the list doesn't have yet: the list is out of date. Anything else is a bug.
      if (!(error instanceof RangeError)) throw error
    }
    if (!reports) {
      body = (
        <LoadError
          onRetry={() => {
            refetchGroups()
            void shares.refetch()
          }}
        />
      )
    } else {
      const chosen = reports.find((report) => report.month === month)?.reports ?? []
      body =
        chosen.length === 0 ? (
          <p className="text-muted-foreground">Nothing recorded in {formatMonth(month, 'long')}.</p>
        ) : (
          chosen.map((report) => <MonthReportView key={report.currency} report={report} />)
        )
      history = (
        <HistorySection months={months} reports={reports} selected={month} onSelect={select} />
      )
    }
  }

  return (
    <>
      <section aria-labelledby="month-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="month-heading" aria-live="polite" className="text-lg font-medium">
            {formatMonth(month, 'long')}
          </h2>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => select(shiftMonth(month, -1))}>
              <span aria-hidden="true">‹</span>
              <span className="sr-only">Previous month</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => select(shiftMonth(month, 1))}>
              <span aria-hidden="true">›</span>
              <span className="sr-only">Next month</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => select(current)}>
              This month
            </Button>
          </div>
        </div>
        {body}
      </section>
      {history}
    </>
  )
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p role="alert" className="text-destructive">
        We couldn’t load your spending and income.
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/** One currency's month: spending by category, income and earnings. */
function MonthReportView({ report }: { report: PersonalReport }) {
  const { currency } = report
  const categories = Object.entries(report.spendingByCategory).sort(([, a], [, b]) => b - a)
  const largest = Math.max(0, ...categories.map(([, cents]) => cents))
  const headingId = `month-${currency}`
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <h3 id={headingId} className="font-medium">
        {currency}
      </h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt>Spending</dt>
        <dd className="text-right font-medium">{formatMoney(report.spendingCents, currency)}</dd>
        <dt>Income</dt>
        <dd className="text-right font-medium">{formatMoney(report.incomeCents, currency)}</dd>
        <dt className="pl-4 text-sm text-muted-foreground">From employers</dt>
        <dd className="text-right text-sm text-muted-foreground">
          {formatMoney(report.incomeCents - report.personalIncomeCents, currency)}
        </dd>
        <dt className="pl-4 text-sm text-muted-foreground">Personal income</dt>
        <dd className="text-right text-sm text-muted-foreground">
          {formatMoney(report.personalIncomeCents, currency)}
        </dd>
        <dt>Earnings from shifts</dt>
        <dd className="text-right font-medium">{formatMoney(report.earningsCents, currency)}</dd>
      </dl>
      {categories.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Spending by category</h4>
          <ul className="flex flex-col gap-2">
            {categories.map(([category, cents]) => (
              <li key={category} className="flex flex-col gap-1">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words">{categoryLabel(category)}</span>
                  <span className="shrink-0">{formatMoney(cents, currency)}</span>
                </div>
                {/* Decoration only: the amount is written out above. */}
                <div aria-hidden="true" className="h-2 rounded-sm bg-muted">
                  <div
                    className="h-2 rounded-sm bg-primary"
                    style={{ width: `${largest > 0 ? (Math.max(0, cents) / largest) * 100 : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Spending and income per month, one list per currency. Choosing a month selects it above. */
function HistorySection({
  months,
  reports,
  selected,
  onSelect,
}: {
  months: Month[]
  reports: MonthReport[]
  selected: Month
  onSelect: (month: Month) => void
}) {
  const currencies = [
    ...new Set(reports.flatMap((month) => month.reports.map((report) => report.currency))),
  ].sort()
  if (currencies.length === 0) return null
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="text-lg font-medium">
        Last {HISTORY_MONTHS} months
      </h2>
      {currencies.map((currency) => (
        <section key={currency} aria-label={`Last ${HISTORY_MONTHS} months in ${currency}`}>
          <h3 className="mb-2 font-medium">{currency}</h3>
          <ul className="flex flex-col gap-1">
            {months.map((month) => {
              const report = reports
                .find((entry) => entry.month === month)
                ?.reports.find((entry) => entry.currency === currency)
              return (
                <li key={month}>
                  <button
                    type="button"
                    aria-pressed={month === selected}
                    onClick={() => onSelect(month)}
                    className="flex w-full flex-wrap justify-between gap-x-3 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:font-medium"
                  >
                    <span>{formatMonth(month, 'short')}</span>
                    <span>
                      Spent {formatMoney(report?.spendingCents ?? 0, currency)} · Income{' '}
                      {formatMoney(report?.incomeCents ?? 0, currency)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </section>
  )
}
