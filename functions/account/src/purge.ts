import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type {
  Balances,
  Groups,
  Invites,
  Items,
  Members,
  Persons,
  Shares,
  Statements,
  Transactions,
} from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows, pages } from '@ledgerly/server/appwrite/pages'
import { TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import {
  FORMER_MEMBER,
  isLonePlaceholder,
  isPlaceholder,
} from '@ledgerly/server/identity/resolve-person'
import {
  type ReceiptChange,
  receiptRows,
  writeReceiptRows,
} from '@ledgerly/server/ledger/receipt-files'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, type Models, Permission, Query, Role } from 'node-appwrite'
import { getRowOrNull } from './rows'
import type { FilesApi, Services } from './services'

// data-model.md#storage-buckets
const RECEIPTS_BUCKET = 'receipts'
const STATEMENTS_BUCKET = 'statements'
// Appwrite's limit on the values in one `equal`.
const IDS_PER_QUERY = 100

/**
 * The purge of a group nobody else is in (identity-and-invites.md#each-group-they-joined), once
 * its `archivedAt` is set and its team is gone: its statements' PDFs, then its rows, each
 * transaction's receipts just before the batch that deletes it, then each other member row,
 * marking a placeholder it leaves with none, then the group row with their own member row, which
 * ends it. Each step reads what's left, so a rerun carries on from wherever the last one stopped;
 * lists are paged by $id (pages.ts), since their rows go meanwhile. False when the time budget is
 * used up first.
 */
export async function purge(services: Services, own: Members): Promise<boolean> {
  if (!(await deletePdfs(services, own.groupId))) return false
  if (!(await deleteRows(services, own.groupId))) return false
  if (!(await deleteMembers(services, own))) return false
  const { db } = services
  const group = await getRowOrNull<Groups>(db, TABLES.groups, own.groupId)
  await withTransaction(db, async (tx) => {
    await tx.write(
      ...(group ? [remove(TABLES.groups, group.$id)] : []),
      remove(TABLES.members, own.$id),
    )
    // A nightly check that read the team before it went may have built the balances row again.
    // Read once the group row is staged: a rebuild writes that row too, so one that commits
    // after this read fails this commit, and one before it is seen here.
    if (await getRowOrNull<Balances>(db, TABLES.balances, own.groupId)) {
      await tx.write(remove(TABLES.balances, own.groupId))
    }
  })
  return true
}

// Its statements' PDFs, before the rows that name them; a group has one statement a period at
// most, so every run looks at them all. Only a file readable by exactly the group's team goes.
async function deletePdfs(services: Services, groupId: string): Promise<boolean> {
  // idx_group_period
  for await (const row of pages<Statements>(services, TABLES.statements, [
    Query.equal('groupId', groupId),
  ])) {
    // Finalize uploads the PDF under the statement's ID before it sets `pdfFileId`, so a
    // finalize stuck in between leaves one there.
    await deleteFile(services.files, STATEMENTS_BUCKET, row.pdfFileId ?? row.$id, groupId)
  }
  return !services.outOfTime()
}

// The receipts of a transaction about to go, just before the batch that deletes it, so a run
// that stops keeps what it has done. A crash in between leaves the row naming a gone file, which
// the next run counts as done. A file goes only when it's readable by exactly the group's team
// and its `receiptFiles` row lists this transaction and none outside the group
// (data-model.md#receiptfiles): one shared with another group's transaction stays, and so does
// one with no row, attached before the ledger kept them, which may be listed elsewhere. `handled`
// holds the files this run has decided on. False when the time budget is used up before a file:
// the transaction is left for the next run. Once one of its files is gone, the rest go too, so
// the batch that deletes it follows in this run, and the next run looks at that file again only
// where another of the group's transactions lists it.
async function deleteReceipts(
  services: Services,
  groupId: string,
  row: Transactions,
  handled: Set<string>,
): Promise<boolean> {
  const fileIds = (row.receiptFileIds ?? []).filter((fileId) => !handled.has(fileId))
  if (fileIds.length === 0) return true
  const { db, files } = services
  const listings = await receiptRows(db, fileIds)
  const listedIds = [...listings.values()].flatMap((listing) => listing.transactionIds ?? [])
  const ofGroup = await groupTransactions(db, groupId, row.$id, listedIds)
  let deleted = false
  for (const fileId of fileIds) {
    if (!deleted && services.outOfTime()) return false
    const listed = listings.get(fileId)?.transactionIds ?? []
    if (listed.includes(row.$id) && listed.every((id) => ofGroup.has(id))) {
      if (await deleteFile(files, RECEIPTS_BUCKET, fileId, groupId)) deleted = true
    }
    handled.add(fileId)
  }
  return true
}

// Which of these transactions are the group's: `known`, and those of the others read by ID.
async function groupTransactions(
  db: Db,
  groupId: string,
  known: string,
  transactionIds: string[],
): Promise<Set<string>> {
  const found = new Set([known])
  const others = [...new Set(transactionIds)].filter((id) => id !== known)
  for (let start = 0; start < others.length; start += IDS_PER_QUERY) {
    const rows = await allRows<Transactions>(db, TABLES.transactions, [
      Query.equal('$id', others.slice(start, start + IDS_PER_QUERY)),
    ])
    for (const row of rows) if (row.groupId === groupId) found.add(row.$id)
  }
  return found
}

// True when it deleted the file: one readable by exactly the group's team. A file that's already
// gone counts as done; a missing bucket doesn't.
async function deleteFile(
  files: FilesApi,
  bucketId: string,
  fileId: string,
  groupId: string,
): Promise<boolean> {
  try {
    const [only, ...more] = (await files.getFile({ bucketId, fileId })).$permissions
    if (only !== Permission.read(Role.team(groupId)) || more.length > 0) return false
    await files.deleteFile({ bucketId, fileId })
    return true
  } catch (error) {
    if (error instanceof AppwriteException && error.type === 'storage_file_not_found') return false
    throw error
  }
}

// Every row of the group but its member rows and the group row, with the invites to its member
// rows, in transactions of at most 90 writes: each transaction with its shares and items, and its
// receipts taken off (their files deleted just before, deleteReceipts), never split, and the
// balances row with the first, so the cache never disagrees with the shares. Each batch also
// gives the group row a fresh `rev`, as every other writer of shares does (ledger.md#concurrency),
// so a nightly check reading the group meanwhile sees it change, and its repair fails rather than
// build the balances row again. The `receiptFiles` rows stay, the deleted files' rows detached:
// scheduler step 5 deletes them (data-model.md#receiptfiles).
async function deleteRows(services: Services, groupId: string): Promise<boolean> {
  const { db, now } = services
  let batch: Write[] = []
  let receipts: ReceiptChange[] = []
  const flush = async () => {
    if (batch.length === 0) return
    const guard: Write = {
      action: 'update',
      tableId: TABLES.groups,
      rowId: groupId,
      data: { rev: randomId() },
    }
    await withTransaction(db, async (tx) => {
      await tx.write(guard, ...batch)
      // Read now and again once staged (writeReceiptRows): a change meanwhile, such as an attach
      // in another group, leaves the group to the next run.
      const rows = await receiptRows(db, [...new Set(receipts.map(({ fileId }) => fileId))])
      await writeReceiptRows(db, tx, rows, receipts, now)
    })
    batch = []
    receipts = []
  }
  // With the guard, at most 90 writes, counting one receipt row write for each file each
  // transaction lists (writeReceiptRows writes a file once, so maybe fewer).
  const add = async (writes: Write[], taken: ReceiptChange[] = []) => {
    const size = batch.length + receipts.length + writes.length + taken.length
    if (size > MAX_OPS_PER_DB_TRANSACTION - 1) await flush()
    batch.push(...writes)
    receipts.push(...taken)
  }
  if (await getRowOrNull<Balances>(db, TABLES.balances, groupId)) {
    await add([remove(TABLES.balances, groupId)])
  }
  const ofGroup = [Query.equal('groupId', groupId)]
  const handled = new Set<string>()
  // idx_group_date, then idx_transactionId and idx_transaction_position
  for await (const row of pages<Transactions>(services, TABLES.transactions, ofGroup)) {
    if (!(await deleteReceipts(services, groupId, row, handled))) {
      // Out of time: the batches whose files are gone still go.
      await flush()
      return false
    }
    const ofRow = [Query.equal('transactionId', row.$id)]
    const shares = await allRows<Shares>(db, TABLES.shares, ofRow)
    const items = await allRows<Items>(db, TABLES.items, ofRow)
    await add(
      [
        ...shares.map((share) => remove(TABLES.shares, share.$id)),
        ...items.map((item) => remove(TABLES.items, item.$id)),
        remove(TABLES.transactions, row.$id),
      ],
      (row.receiptFileIds ?? []).map((fileId) => ({ fileId, remove: [row.$id] })),
    )
  }
  // Any share whose transaction is gone (I-6 allows none), which would break I-3 once the member
  // rows go. Read once the batches above are in, so none is found twice. idx_group_person_date
  await flush()
  for await (const share of pages<Shares>(services, TABLES.shares, ofGroup)) {
    await add([remove(TABLES.shares, share.$id)])
  }
  // idx_groupId, idx_group_period, idx_group_at, idx_groupId
  for (const tableId of [TABLES.schedules, TABLES.statements, TABLES.activity, TABLES.reminders]) {
    for await (const row of pages<Models.Row>(services, tableId, ofGroup)) {
      await add([remove(tableId, row.$id)])
    }
  }
  // Every invite to one of its member rows, whoever sent it: each holds the address it went to.
  // Found through the member rows, so before they go. idx_groupId, then invites.memberId, which
  // has no index: Appwrite reads the small table, as step 5 does (delete-account.ts).
  const memberIds: string[] = []
  for await (const member of pages<Members>(services, TABLES.members, ofGroup)) {
    memberIds.push(member.$id)
  }
  for (let start = 0; start < memberIds.length; start += IDS_PER_QUERY) {
    const toMembers = [Query.equal('memberId', memberIds.slice(start, start + IDS_PER_QUERY))]
    for (const invite of await allRows<Invites>(db, TABLES.invites, toMembers)) {
      await add([remove(TABLES.invites, invite.$id)])
    }
  }
  await flush()
  return !services.outOfTime()
}

// Every other member row, once no share is left (I-3), each in a transaction of its own. A
// placeholder's person gets a staged write with it: a fresh `rev`, and `orphanedAt` now when no
// other member row names it, so scheduler step 5c deletes its identities and name 30 days later
// (scheduling.md#step-5c-placeholder-clean-up). So a crash never leaves one unmarked that a rerun
// can't find. Then whether it's the last row is checked again: a merged person isn't marked, and
// two purges deleting its last two rows at once fail one commit rather than leave it unmarked. A
// row that another deletion under way purges the group from itself is left to it (ownPurgeEnds).
async function deleteMembers(services: Services, own: Members): Promise<boolean> {
  const { db, now } = services
  // idx_groupId
  for await (const member of pages<Members>(services, TABLES.members, [
    Query.equal('groupId', own.groupId),
  ])) {
    if (member.$id === own.$id || (await ownPurgeEnds(db, member))) continue
    const person = await getRowOrNull<Persons>(db, TABLES.persons, member.personId)
    const placeholder = person !== null && isPlaceholder(person)
    const alone = placeholder && (await isLonePlaceholder(db, member.personId, member.$id))
    await withTransaction(db, async (tx) => {
      await tx.write(remove(TABLES.members, member.$id))
      if (!placeholder) return
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: member.personId,
        data: { rev: randomId(), ...(alone ? { orphanedAt: now.toISOString() } : {}) },
      })
      // Stage, then check: the stored rows, not this transaction's view.
      if ((await isLonePlaceholder(db, member.personId, member.$id)) !== alone) throw new Raced()
    })
  }
  return !services.outOfTime()
}

// Whether the row is one whose own deletion purges the group and deletes it last: an `active`
// or `left` row without the keep's write (step 4 still has it to do), of a person being deleted
// (`deletedAt` set, `userId` not yet cleared by step 6). Deleting it would fail that purge's last
// transaction, and two deletions purging one group would each fail the other's, leaving the
// group row behind for good. Any other row of theirs goes: a placeholder row they never joined,
// or a kept one, which their deletion doesn't come back to once step 4 is done.
async function ownPurgeEnds(db: Db, member: Members): Promise<boolean> {
  const kept =
    member.status === 'left' && member.role === 'viewer' && member.displayName === FORMER_MEMBER
  if (kept || (member.status !== 'active' && member.status !== 'left')) return false
  const person = await getRowOrNull<Persons>(db, TABLES.persons, member.personId)
  return Boolean(person?.deletedAt && person.userId)
}

function remove(tableId: TableId, rowId: string): Write {
  return { action: 'delete', tableId, rowId }
}
