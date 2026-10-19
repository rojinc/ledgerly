import type { Models } from 'node-appwrite'
import { Query } from 'node-appwrite'
import type { Db } from './client'
import { DATABASE_ID, type TableId } from './tables'

const PAGE = 100

/**
 * Every matching row, a page of 100 at a time, until the run's time budget is used up. Pages
 * follow `$id` rather than a cursor row (scaling.md): the rows a step goes through can be
 * deleted meanwhile, and a deleted cursor row fails the query.
 */
export async function* pages<R extends Models.Row>(
  { db, outOfTime }: { db: Db; outOfTime: () => boolean },
  tableId: TableId,
  queries: string[],
): AsyncGenerator<R> {
  let after: string | undefined
  while (!outOfTime()) {
    const { rows } = await db.listRows<R>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        ...queries,
        ...(after === undefined ? [] : [Query.greaterThan('$id', after)]),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
      ],
      total: false,
    })
    for (const row of rows) {
      // One row can take several requests, an email or a whole expansion among them.
      if (outOfTime()) return
      yield row
    }
    if (rows.length < PAGE) return
    after = rows[rows.length - 1]?.$id
  }
}

/** Every matching row, however far the run has got, paged as `pages` does. */
export async function allRows<R extends Models.Row>(
  db: Db,
  tableId: TableId,
  queries: string[],
): Promise<R[]> {
  const rows: R[] = []
  for await (const row of pages<R>({ db, outOfTime: () => false }, tableId, queries)) {
    rows.push(row)
  }
  return rows
}
