import type { Groups, Shares } from '@ledgerly/core/generated/rows'
import { type Net, netsFromShares } from '@ledgerly/core/settle/nets'
import { AppwriteException, Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import { AppError } from '../http/app-error'
import { listAll } from './transactions'

const READS = 3

/**
 * Each person's net in `group` (ledger.md#balances), from their shares: what `GET /balances` and
 * a reminder (identity-and-invites.md#reminders) both read, so they can't disagree. `group` is
 * the row as read before the shares. The shares are read a page at a time. Every write of shares
 * also writes a fresh `rev` to the group row (ledger.md#concurrency), so the same `rev` before
 * and after means no write committed in between: the read is whole. Otherwise it is read again,
 * up to 3 times, then CONFLICT.
 */
export async function readGroupNets(db: Db, group: Groups): Promise<Net[]> {
  let before = group
  for (let read = 0; read < READS; read++) {
    const shares = await readShares(db, before.$id)
    const after = await db.getRow<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      rowId: before.$id,
    })
    if (shares && after.rev === before.rev) return netsFromShares(shares)
    before = after
  }
  throw new AppError('CONFLICT', 'The group changed while it was read. Try again.')
}

/** Every share in the group, or undefined when a page's cursor row was deleted meanwhile. */
async function readShares(db: Db, groupId: string): Promise<Shares[] | undefined> {
  try {
    return await listAll<Shares>(db, TABLES.shares, [Query.equal('groupId', groupId)])
  } catch (error) {
    if (error instanceof AppwriteException && error.type === 'general_cursor_not_found') {
      return undefined
    }
    throw error
  }
}
