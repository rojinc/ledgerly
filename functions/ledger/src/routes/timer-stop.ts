import { stopTimerBodySchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { localTime } from './timer-start'
import {
  activityWrite,
  changedColumns,
  getTransaction,
  guardGroupAndMembers,
  guardTransaction,
  invalid,
  ledgerRoute,
  listShares,
  loadLedger,
  money,
  parseBody,
  plan,
  readView,
  replaceRows,
  requireNotFinalizing,
  requireUnlocked,
  shareColumns,
  storedInput,
  teamRead,
  Unchanged,
} from './transactions-shared'

export { stopTimerBodySchema }

const MS_PER_MINUTE = 60_000
// functions-api.md#validation: a shift's minutes are at most one day.
const MAX_SHIFT_MINUTES = 24 * 60

/**
 * `POST /timer/stop` (functions-api.md#ledger; scheduling.md#timer-shifts): posts the running
 * shift with the whole minutes since it started, less the break, and the end time. A retry of a
 * stop that went through, with the same break, gets the posted shift back.
 */
export const stopTimer = route('POST', '/timer/stop', ({ userId, body, db }) =>
  ledgerRoute(async () => {
    const stop = parseBody(stopTimerBodySchema, body)
    const found = await getTransaction(db, stop.transactionId)
    const membership = await requireMember(db, userId, found.groupId, {
      roles: ['admin', 'member'],
    })
    const person = membership.person.$id
    if (found.startedAt === null || !['running', 'posted'].includes(found.status)) {
      invalid('Only a running timer can be stopped.')
    }
    if (found.createdBy !== person) {
      throw new AppError('FORBIDDEN', 'Only the person who started this timer can stop it.')
    }
    requireUnlocked(found)
    const now = new Date()
    const ledger = await loadLedger(db, membership)

    try {
      await withTransaction(db, async (tx) => {
        // Everything below reads the row and its stored input as they are now.
        const existing = await guardTransaction(tx, db, found.$id, person, ['running', 'posted'])
        const stored = await storedInput(db, existing)
        const shift = stored.shift as NonNullable<typeof stored.shift>
        if (existing.status === 'posted') {
          if ((stop.breakMinutes ?? 0) === (shift.breakMinutes ?? 0)) throw new Unchanged()
          invalid('This timer has already stopped.')
        }
        const ran = Math.floor(
          (now.getTime() - Date.parse(existing.startedAt as string)) / MS_PER_MINUTE,
        )
        const breakMinutes = stop.breakMinutes ?? 0
        if (breakMinutes > ran) invalid('The break is longer than the timer ran.')
        if (ran - breakMinutes > MAX_SHIFT_MINUTES) {
          invalid('This timer ran for more than a day. Void it and add the shift by hand.')
        }
        const input = {
          ...stored,
          shift: {
            ...shift,
            minutes: ran - breakMinutes,
            ...(stop.breakMinutes === undefined ? {} : { breakMinutes }),
            endTime: localTime(membership.group.timezone, now),
          },
        }
        const planned = plan(input, 'posted', ledger)
        const columns = {
          status: 'posted' as const,
          totalCents: planned.totalCents,
          inputJson: planned.inputJson,
        }
        await guardGroupAndMembers(tx, db, membership.group, ledger, planned.people)
        await requireNotFinalizing(db, existing.groupId, [existing.date])
        // A running shift has no shares (I-6), so this replaces none.
        const oldShares = await listShares(db, existing.$id)
        await tx.write(
          { action: 'update', tableId: TABLES.transactions, rowId: existing.$id, data: columns },
          ...replaceRows(
            TABLES.shares,
            oldShares,
            planned.shares.map((share) => shareColumns(existing, share)),
            teamRead(existing.groupId),
          ),
          activityWrite(
            existing,
            person,
            'transaction.posted',
            `Stopped the timer for “${existing.description}” (${money(planned.totalCents, membership.group)})`,
            changedColumns(existing as unknown as Record<string, unknown>, columns),
            now,
          ),
        )
      })
    } catch (error) {
      if (!(error instanceof Unchanged)) throw error
    }
    return readView(db, found.$id)
  }),
)
