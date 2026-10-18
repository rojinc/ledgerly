import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Transactions } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { startTimerBodySchema, type TransactionInput } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { Query } from 'node-appwrite'
import { OCCURRENCE_ID } from './transactions-create'
import {
  activityWrite,
  findTransaction,
  guardGroupAndMembers,
  invalid,
  ledgerRoute,
  loadLedger,
  parseBody,
  plan,
  readView,
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
export const startTimer = route('POST', '/timer/start', ({ userId, body, db }) =>
  ledgerRoute(async () => {
    const start = parseBody(startTimerBodySchema, body)
    if (OCCURRENCE_ID.test(start.id)) invalid('This id is kept for schedule occurrences.')
    const membership = await requireMember(db, userId, start.groupId, { roles: ['admin'] })
    const { group } = membership
    const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
    if (settings.type !== 'employer') invalid('Only an employer group has a timer.')
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
    await withTransaction(db, async (tx) => {
      // The guard writes the person's member row, so of two starts at once in this group one
      // commit fails and its rerun finds the other's timer here (ledger.md#concurrency).
      await guardGroupAndMembers(tx, db, group, ledger, planned.people)
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

/** The person's running timer in any group: they work one shift at a time. */
async function findRunning(db: Db, personId: string): Promise<Transactions | undefined> {
  const { rows } = await db.listRows<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    queries: [Query.equal('status', 'running'), Query.equal('createdBy', personId), Query.limit(1)],
    total: false,
  })
  return rows[0]
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
