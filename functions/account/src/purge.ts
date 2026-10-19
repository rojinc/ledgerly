import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type {
  Balances,
  Groups,
  Identities,
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
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import {
  type ReceiptChange,
  receiptRows,
  writeReceiptRows,
} from '@ledgerly/server/ledger/receipt-files'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, type Models, Permission, Query, Role } from 'node-appwrite'
import { FORMER_MEMBER, getRowOrNull, isPlaceholder } from './rows'
import type { FilesApi, Services } from './services'

// data-model.md#storage-buckets
const RECEIPTS_BUCKET = 'receipts'
const STATEMENTS_BUCKET = 'statements'
// Appwrite's limit on the values in one `equal`.
const IDS_PER_QUERY = 100

/**
 * The purge of a group nobody else is in (identity-and-invites.md#each-group-they-joined), once
 * its `archivedAt` is set and its team is gone: its files, then its rows, then each other member
 * row with its placeholder, then the group row with their own member row, which ends it. Each
 * step reads what's left, so a rerun carries on from wherever the last one stopped; lists are
 * paged by $id (pages.ts), since their rows go meanwhile. False when the time budget is used up
 * first.
 */
export async function purge(services: Services, own: Members): Promise<boolean> {
  if (!(await deleteFiles(services, own.groupId))) return false
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

// The receipts only its transactions list and its statements' PDFs, before the rows that name
// them. Only a file readable by exactly the group's team goes. A receipt also needs a
// `receiptFiles` row that lists no transaction outside the group, so one shared with another
// group's transaction stays, and so does one with no row: it was attached before the ledger kept
// them, and may be listed elsewhere (data-model.md#receiptfiles).
async function deleteFiles(services: Services, groupId: string): Promise<boolean> {
  const { db, files } = services
  const transactionIds = new Set<string>()
  const fileIds = new Set<string>()
  // idx_group_date
  for await (const row of pages<Transactions>(services, TABLES.transactions, [
    Query.equal('groupId', groupId),
  ])) {
    transactionIds.add(row.$id)
    for (const fileId of row.receiptFileIds ?? []) fileIds.add(fileId)
  }
  // Only to stop on time: with some transactions not read, a row that names one of them counts
  // as listed elsewhere, so fewer files would go, never more.
  if (services.outOfTime()) return false
  const listed = [...fileIds]
  for (let start = 0; start < listed.length; start += IDS_PER_QUERY) {
    const chunk = listed.slice(start, start + IDS_PER_QUERY)
    const rows = await receiptRows(db, chunk)
    for (const fileId of chunk) {
      // Each file takes up to two Storage calls. No row has been touched yet, so a rerun is safe.
      if (services.outOfTime()) return false
      const row = rows.get(fileId)
      if (row && (row.transactionIds ?? []).every((id) => transactionIds.has(id))) {
        await deleteFile(files, RECEIPTS_BUCKET, fileId, groupId)
      }
    }
  }
  // idx_group_period
  const statements = pages<Statements>(services, TABLES.statements, [
    Query.equal('groupId', groupId),
  ])
  for await (const row of statements) {
    // Finalize uploads the PDF under the statement's ID before it sets `pdfFileId`, so a
    // finalize stuck in between leaves one there.
    await deleteFile(files, STATEMENTS_BUCKET, row.pdfFileId ?? row.$id, groupId)
  }
  return !services.outOfTime()
}

// A file that's already gone counts as done; a missing bucket doesn't.
async function deleteFile(files: FilesApi, bucketId: string, fileId: string, groupId: string) {
  try {
    const [only, ...more] = (await files.getFile({ bucketId, fileId })).$permissions
    if (only === Permission.read(Role.team(groupId)) && more.length === 0) {
      await files.deleteFile({ bucketId, fileId })
    }
  } catch (error) {
    if (!(error instanceof AppwriteException && error.type === 'storage_file_not_found')) {
      throw error
    }
  }
}

// Every row of the group but its member rows and the group row, with the invites to its member
// rows, in transactions of at most 90 writes: each transaction with its shares and items, and its receipts taken off, never split,
// and the balances row with the first, so the cache never disagrees with the shares. Each batch
// also gives the group row a fresh `rev`, as every other writer of shares does
// (ledger.md#concurrency), so a nightly check reading the group meanwhile sees it change, and
// its repair fails rather than build the balances row again. The `receiptFiles` rows stay, the
// deleted files' rows detached: scheduler step 5 deletes them (data-model.md#receiptfiles).
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
  // idx_group_date, then idx_transactionId and idx_transaction_position
  for await (const row of pages<Transactions>(services, TABLES.transactions, ofGroup)) {
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

// Every other member row, once no share is left (I-3), each in a transaction of its own with
// its person and identities when that person is a placeholder no other member row names. So a
// crash never leaves a placeholder that a rerun can't find. The person goes only after a staged
// write, and only if, checked again after it, that still holds: a merged person is kept. A row
// that another deletion under way purges the group from itself is left to it (ownPurgeEnds).
async function deleteMembers(services: Services, own: Members): Promise<boolean> {
  const { db } = services
  // idx_groupId
  for await (const member of pages<Members>(services, TABLES.members, [
    Query.equal('groupId', own.groupId),
  ])) {
    if (member.$id === own.$id || (await ownPurgeEnds(db, member))) continue
    const alone = await isLonePlaceholder(db, member)
    await withTransaction(db, async (tx) => {
      await tx.write(remove(TABLES.members, member.$id))
      if (!alone) return
      // idx_personId
      const identities = await allRows<Identities>(db, TABLES.identities, [
        Query.equal('personId', member.personId),
      ])
      await tx.write(
        ...identities.map((row) => remove(TABLES.identities, row.$id)),
        remove(TABLES.persons, member.personId),
      )
      // Stage, then check: the stored rows, not this transaction's view.
      if (!(await isLonePlaceholder(db, member))) throw new Raced()
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

// Whether the member's person is a placeholder (isPlaceholder) with no member row but this one.
async function isLonePlaceholder(db: Db, member: Members): Promise<boolean> {
  const person = await getRowOrNull<Persons>(db, TABLES.persons, member.personId)
  if (!person || !isPlaceholder(person)) return false
  // idx_person_status. A person has one row per group (uniq_group_person).
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('personId', person.$id), Query.limit(2)],
    total: false,
  })
  return rows.every((row) => row.$id === member.$id)
}

function remove(tableId: TableId, rowId: string): Write {
  return { action: 'delete', tableId, rowId }
}
