import type { AppwriteException, Client, Query, Storage, TablesDB } from 'node-appwrite'
import type { backfillReceiptFiles } from '../functions/ledger/src/backfill-receipt-files'
import type { backfillOrphanedAt } from '../functions/scheduler/src/backfill-orphaned-at'

/** The backfills and the node-appwrite classes, from one bundle with one copy of node-appwrite. */
export function bundleBackfill(): Promise<{
  backfillReceiptFiles: typeof backfillReceiptFiles
  backfillOrphanedAt: typeof backfillOrphanedAt
  AppwriteException: typeof AppwriteException
  Client: typeof Client
  Query: typeof Query
  Storage: typeof Storage
  TablesDB: typeof TablesDB
}>
