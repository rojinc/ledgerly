import type { Balances } from '@ledgerly/core/generated/rows'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { type BalancesPeople, balancesPeopleSchema } from '@ledgerly/core/schemas/ledger'
import { applyShares, type ShareAmounts } from '@ledgerly/core/settle/balances'
import { AppwriteException } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import type { Write } from '../appwrite/transaction'

/**
 * The group's `balances` row as people (data-model.md#balances): undefined when it hasn't been
 * backfilled yet, and null when it can't be read, which is a bug.
 */
export async function readBalances(
  db: Db,
  groupId: string,
): Promise<BalancesPeople | null | undefined> {
  let row: Balances
  try {
    row = await db.getRow<Balances>({
      databaseId: DATABASE_ID,
      tableId: TABLES.balances,
      rowId: groupId,
    })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
  try {
    return balancesPeopleSchema.parse(JSON.parse(row.peopleJson))
  } catch {
    return null
  }
}

/**
 * The write that keeps the group's `balances` row when a write of shares replaces `before` with
 * `after` (ledger.md#balances). Call it once the group row's guard write is staged: that makes
 * writes of shares in the group take turns, so the row needs no guard of its own. No row yet, or
 * nothing changed, means no write. A row that doesn't fit the shares is a bug: it's deleted
 * rather than stopping the write, `/balances` sums the shares, and the nightly check rebuilds it.
 */
export async function balanceWrite(
  db: Db,
  groupId: string,
  before: readonly ShareAmounts[],
  after: readonly ShareAmounts[],
): Promise<Write[]> {
  const people = await readBalances(db, groupId)
  if (people === undefined) return []
  const next = people && fitted(people, before, after)
  if (!next) {
    console.error(`balances: the row of group ${groupId} doesn't fit its shares; deleted`)
    return [{ action: 'delete', tableId: TABLES.balances, rowId: groupId }]
  }
  const peopleJson = JSON.stringify(next)
  if (peopleJson === JSON.stringify(people)) return []
  return [{ action: 'update', tableId: TABLES.balances, rowId: groupId, data: { peopleJson } }]
}

/** `applyShares`, or undefined when the row doesn't fit the shares, a net past a safe integer included. */
function fitted(
  people: BalancesPeople,
  before: readonly ShareAmounts[],
  after: readonly ShareAmounts[],
): BalancesPeople | undefined {
  try {
    const next = applyShares(people, before, after)
    return balancesPeopleSchema.safeParse(next).success ? next : undefined
  } catch (error) {
    if (error instanceof LedgerError) return undefined
    throw error
  }
}
