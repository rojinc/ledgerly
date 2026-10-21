import type { Groups, Members, Shares } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { useQueries } from '@tanstack/react-query'
import { Query } from 'appwrite'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { Button } from '../../ui/button'
import { formatDate } from '../statements/invoice-view'
import { KIND_LABEL } from '../transactions/history-page'
import { type HistoryRow, useHistory } from '../transactions/use-transactions'

// Appwrite's limit for one page.
const PAGE = 100

/**
 * Who paid each transaction of one history page: their shares that gave something (a refund's
 * payers give less than 0), on `shares.idx_transactionId`. Only posted transactions have shares
 * (I-6). One query per page, so loading more never reads the earlier pages' payers again. Under
 * the `history` key, so whatever refreshes the house's history refreshes this too.
 */
function payersQuery(groupId: string, ids: string[]) {
  return {
    queryKey: ['history', groupId, 'payers', ...ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const payers: [transactionId: string, personId: string][] = []
      let cursor: string | undefined
      for (;;) {
        const { rows } = await tablesDB.listRows<Shares>({
          databaseId: DATABASE_ID,
          tableId: 'shares',
          queries: [
            Query.equal('transactionId', ids),
            Query.notEqual('givenCents', 0),
            Query.select(['$id', 'transactionId', 'personId']),
            Query.limit(PAGE),
            ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
          ],
        })
        payers.push(...rows.map((share): [string, string] => [share.transactionId, share.personId]))
        if (rows.length < PAGE) return payers
        cursor = rows.at(-1)?.$id
      }
    },
  }
}

/** A row's status in words, never by colour or strike-through alone. Posted says nothing. */
function statusText(row: HistoryRow): string {
  switch (row.status) {
    case 'void':
      return 'Void'
    // Every writer dates a due bill on its due date: the scheduler (scheduling.md) and the bill
    // forms. If one ever doesn't, add `dueOn` to useHistory's columns.
    case 'due':
      return `Due ${formatDate(row.date)}`
    case 'scheduled':
      return 'Scheduled'
    case 'running':
      return 'Running'
    default:
      return ''
  }
}

/**
 * The house's transactions, newest first, in `useHistory`'s pages (#183): every status, for
 * everyone who can open the house, including viewers and people who moved out.
 */
export function HouseHistory({
  group,
  members,
  canAdd,
}: {
  group: Groups
  members: Members[]
  /** Admins and members of a house that isn't archived: the empty state offers Add expense. */
  canAdd: boolean
}) {
  const history = useHistory(group.$id, {})
  const pages = history.data?.pages ?? []
  const rows = pages.flat()
  const payerPages = useQueries({
    queries: pages.map((page) =>
      payersQuery(
        group.$id,
        page.map((row) => row.$id),
      ),
    ),
  })
  const payers = new Map<string, string[]>()
  for (const [transactionId, personId] of payerPages.flatMap((page) => page.data ?? [])) {
    payers.set(transactionId, [...(payers.get(transactionId) ?? []), personId])
  }
  const payersFailed = payerPages.some((page) => page.isError)
  const names = new Map(members.map((member) => [member.personId, member.displayName]))
  const list = new Intl.ListFormat(undefined, { type: 'conjunction' })

  let content: ReactNode
  if (!history.data) {
    content = history.isError ? (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-destructive">
          We couldn’t load the history.
        </p>
        <Button variant="outline" onClick={() => history.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  } else if (rows.length === 0) {
    content = (
      <p className="text-muted-foreground">
        No expenses yet.
        {canAdd && (
          <>
            {' '}
            <Link
              to={`/transactions/new?groupId=${group.$id}`}
              className="underline underline-offset-4"
            >
              Add expense
            </Link>
          </>
        )}
      </p>
    )
  } else {
    content = (
      <>
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => {
            const paidBy = (payers.get(row.$id) ?? []).map(
              (personId) => names.get(personId) ?? 'Someone',
            )
            const status = statusText(row)
            return (
              <li key={row.$id}>
                {/* The details run under the amount too, so a long amount doesn't squeeze them at
                    375 px (#502). The DOM order is unchanged, so the link's name is too. */}
                <Link
                  to={`/transactions/${row.$id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span
                    className={`font-medium break-words ${row.status === 'void' ? 'line-through' : ''}`}
                  >
                    {row.description || KIND_LABEL[row.kind]}
                  </span>
                  <span className="col-span-2 text-sm break-words text-muted-foreground">
                    {[
                      formatDate(row.date),
                      paidBy.length > 0 && `Paid by ${list.format(paidBy)}`,
                      status,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="col-start-2 row-start-1 tabular-nums">
                    {formatMoney(row.totalCents, group.currency)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
        {payersFailed && (
          <p className="text-sm text-muted-foreground">We couldn’t load who paid.</p>
        )}
        {history.isFetchNextPageError && (
          <p role="alert" className="text-destructive">
            We couldn’t load more. Try again.
          </p>
        )}
        {history.hasNextPage && (
          // aria-disabled, not disabled: a disabled button loses focus.
          <Button
            variant="outline"
            className="self-start"
            aria-disabled={history.isFetchingNextPage}
            onClick={() => {
              if (!history.isFetchingNextPage) void history.fetchNextPage()
            }}
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        )}
      </>
    )
  }

  return (
    <section aria-labelledby="house-history" className="flex flex-col gap-2">
      <h2 id="house-history" className="font-medium">
        History
      </h2>
      {content}
    </section>
  )
}
