import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { startTimerBodySchema, type TransactionInput } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { randomId } from '@ledgerly/server/identity/random-id'
import { Query } from 'node-appwrite'
import { teamsFor } from '../teams'
import { OCCURRENCE_ID } from './transactions-create'
import {
  activityWrite,
  findTransaction,
  guardGroupAndMembers,
  invalid,
  ledgerRoute,
  listAll,
  loadLedger,
  parseBody,
  plan,
  readView,
  requireNotFinalizing,
  storedInputSchema,
  teamRead,
  transactionColumns,
} from './transactions-shared'

export { startTimerBodySchema }

const DESCRIPTION = 'Shift'

/**
 * `POST /timer/start` (functions-api.md#ledger; scheduling.md#timer-shifts): a `running` shift
 * from now, dated today in the group's time zone, at the body's rate or the group's default. It
 * has no shares until it stops (I-6). A person has one running timer at a time: starting another
 * is a CONFLICT that names the running one. A retry with the same `id` gets the timer back.
 */
export const startTimer = route('POST', '/timer/start', ({ userId, body, db, headers }) =>
  ledgerRoute(async () => {
    const start = parseBody(startTimerBodySchema, body)
    if (OCCURRENCE_ID.test(start.id)) invalid('This id is kept for schedule occurrences.')
    const membership = await requireMember(db, teamsFor(headers), userId, start.groupId, {
      roles: ['admin'],
    })
    const { group } = membership
    const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
    if (settings.type !== 'employer') invalid('Only an employer group has a timer.')
    // A shift always pays the group's owner (ledger.md#transaction-kinds), so only they time it.
    if (membership.person.$id !== group.ownerPersonId) {
      throw new AppError('FORBIDDEN', 'Only the person this group pays can start its timer.')
    }
    const now = new Date()
    const person = membership.person.$id
    const input: TransactionInput = {
      id: start.id,
      groupId: group.$id,
      kind: 'shift',
      date: localToday(group.timezone, now),
      description: start.description ?? DESCRIPTION,
      shift: {
        minutes: 0,
        rateCents: start.rateCents ?? settings.defaultRateCents,
        startTime: localTime(group.timezone, now),
      },
    }

    const existing = await findTransaction(db, input.id)
    if (existing) {
      // The date and start time are left out: a retry can come a minute, or a day, later.
      const same =
        existing.groupId === input.groupId &&
        existing.kind === 'shift' &&
        existing.startedAt !== null &&
        existing.createdBy === person &&
        existing.description === input.description &&
        existing.voidReason === null &&
        storedInputSchema.parse(JSON.parse(existing.inputJson)).shift?.rateCents ===
          input.shift?.rateCents
      if (!same) throw new AppError('CONFLICT', 'A different transaction already has this ID.')
      return readView(db, existing.$id)
    }

    const ledger = await loadLedger(db, membership)
    const planned = plan(input, 'running', ledger)
    const personal = await findPersonalGroup(db, person)
    await withTransaction(db, async (tx) => {
      await guardGroupAndMembers(tx, db, group, ledger, planned.people)
      // Every start by this person, in any group, also writes their personal group's row. So of
      // two starts at once one commit fails, and its rerun finds the other's timer below
      // (ledger.md#concurrency).
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: personal.$id,
        data: { rev: randomId() },
      })
      await requireNotFinalizing(db, group.$id, [input.date])
      const running = await findRunning(db, person)
      if (running) {
        throw new AppError('CONFLICT', 'A timer is already running.', {
          transactionId: running.$id,
        })
      }
      const row = { $id: input.id, groupId: input.groupId, description: input.description }
      await tx.write(
        {
          action: 'create',
          tableId: TABLES.transactions,
          rowId: input.id,
          data: {
            ...transactionColumns(input, planned),
            scheduleId: null,
            overridden: false,
            statementId: null,
            receiptFileIds: null,
            startedAt: now.toISOString(),
            remindedAt: null,
            voidReason: null,
            createdBy: person,
            updatedBy: person,
          },
          permissions: teamRead(input.groupId),
        },
        activityWrite(
          row,
          person,
          'transaction.created',
          `Started the timer for “${input.description}”`,
          null,
          now,
        ),
      )
    })
    return readView(db, input.id)
  }),
)

/**
 * The person's running timer in any group that isn't archived: they work one shift at a time. A
 * timer left running in an archived group can't be stopped any more, so it doesn't count. Uses
 * `idx_status_date`: few rows are ever running.
 */
async function findRunning(db: Db, personId: string): Promise<Transactions | undefined> {
  const running = await listAll<Transactions>(db, TABLES.transactions, [
    Query.equal('status', 'running'),
    Query.equal('createdBy', personId),
  ])
  for (const row of running) {
    const group = await db.getRow<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      rowId: row.groupId,
    })
    if (!group.archivedAt) return row
  }
  return undefined
}

/**
 * The person's personal group (`idx_owner_type`). Bootstrap makes it with the person, in one
 * transaction; without it the one-timer guard wouldn't hold, so a start fails rather than run
 * unguarded.
 */
async function findPersonalGroup(db: Db, personId: string): Promise<Groups> {
  const { rows } = await db.listRows<Groups>({
    databaseId: DATABASE_ID,
    tableId: TABLES.groups,
    queries: [
      Query.equal('ownerPersonId', personId),
      Query.equal('type', 'personal'),
      Query.limit(1),
    ],
    total: false,
  })
  const [personal] = rows
  if (!personal) throw new Error('Every person with an account has a personal group')
  return personal
}

/** The wall-clock time `HH:mm` in `timeZone` at `at`: a shift's start and end times. */
export function localTime(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)
}
