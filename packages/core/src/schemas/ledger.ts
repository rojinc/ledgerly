import { z } from 'zod'
import { TRANSACTION_KINDS, type TransactionKind } from '../constants/domain'
import {
  MAX_AMOUNT_CENTS,
  MAX_ITEMS_PER_TRANSACTION,
  MAX_PEOPLE_PER_TRANSACTION,
} from '../constants/limits'
import { shiftAmountCents } from '../money/shift-amount'
import {
  categorySchema,
  centsSchema,
  checkDateOrder,
  descriptionSchema,
  idSchema,
  localDateSchema,
  peopleList,
  rateCentsSchema,
  text,
} from './common'
import { splitPersonIds, splitSpecSchema } from './split'

// functions-api.md#transactioninput and #ledger. Sums (payers, exact splits and
// items against the total) and the sign rules are ledger rules, checked by
// buildShares() and assertShareInvariants().

// A shift is one day's work, which also keeps minutes × rateCents a safe integer.
const MAX_SHIFT_MINUTES = 24 * 60
// ledger checks and resets each attached file within one 30-second execution.
const MAX_RECEIPTS = 10
const minutesSchema = z.int().min(0).max(MAX_SHIFT_MINUTES)
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm')

export const itemInputSchema = z.strictObject({
  name: text(1, 120),
  quantity: z.number().positive().optional(),
  amountCents: centsSchema,
  category: categorySchema.optional(),
  split: splitSpecSchema,
})

export type ItemInput = z.infer<typeof itemInputSchema>

// ledger.md#allocation-and-rounding: computed totals are capped like typed ones.
// Checked only once the parts are valid, so a bad part gets one clear issue.
const totalCap = {
  message: `The total must be at most ${MAX_AMOUNT_CENTS} cents in size`,
  when: (payload: z.core.ParsePayload) => payload.issues.length === 0,
}

function shiftAmountFits(shift: { minutes: number; rateCents: number }): boolean {
  try {
    shiftAmountCents(shift.minutes, shift.rateCents)
    return true
  } catch {
    return false
  }
}

const shiftSchema = z
  .strictObject({
    minutes: minutesSchema,
    rateCents: rateCentsSchema,
    breakMinutes: minutesSchema.optional(),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
  })
  .refine(shiftAmountFits, totalCap)

const itemsSchema = z
  .array(itemInputSchema)
  .min(1)
  .max(MAX_ITEMS_PER_TRANSACTION)
  .refine(
    (items) => Math.abs(items.reduce((sum, item) => sum + item.amountCents, 0)) <= MAX_AMOUNT_CENTS,
    totalCap,
  )

const billSchema = z
  .strictObject({
    status: z.enum(['due', 'paid']),
    dueOn: localDateSchema.optional(),
    periodStart: localDateSchema.optional(),
    periodEnd: localDateSchema.optional(),
  })
  .superRefine((bill, ctx) => checkDateOrder(bill.periodStart, bill.periodEnd, 'periodEnd', ctx))

const paymentSchema = z
  .strictObject({ fromPersonId: idSchema, toPersonId: idSchema })
  .refine((payment) => payment.fromPersonId !== payment.toPersonId, {
    message: 'A payment needs two different people',
    path: ['toPersonId'],
  })

const adjustmentSchema = z.strictObject({
  shares: peopleList(
    z.strictObject({ personId: idSchema, givenCents: centsSchema, receivedCents: centsSchema }),
    (share) => share.personId,
  ),
  reason: text(1, 200),
})

// Everything in a TransactionInput except id, groupId, kind, date and description:
// the shape of a schedule's template.
const transactionFields = {
  category: categorySchema.optional(),
  totalCents: centsSchema.optional(),
  payers: peopleList(
    z.strictObject({ personId: idSchema, cents: centsSchema }),
    (payer) => payer.personId,
  ).optional(),
  split: splitSpecSchema.optional(),
  items: itemsSchema.optional(),
  shift: shiftSchema.optional(),
  bill: billSchema.optional(),
  payment: paymentSchema.optional(),
  adjustment: adjustmentSchema.optional(),
  receiptFileIds: z.array(idSchema).max(MAX_RECEIPTS).optional(),
  note: text(0, 1000).optional(),
}

export const transactionTemplateSchema = z.strictObject(transactionFields)

export type TransactionTemplate = z.infer<typeof transactionTemplateSchema>

type Part =
  | 'shift'
  | 'bill'
  | 'payment'
  | 'adjustment'
  | 'payers'
  | 'split'
  | 'items'
  | 'totalCents'

// The kinds each part of the input belongs to (ledger.md#transaction-kinds).
const PART_KINDS: Record<Part, readonly TransactionKind[]> = {
  shift: ['shift'],
  bill: ['bill'],
  payment: ['payment'],
  adjustment: ['adjustment'],
  payers: ['expense', 'bill', 'loan'],
  split: ['expense', 'bill', 'loan'],
  items: ['expense', 'bill'],
  // A shift's total is minutes × rate, never sent.
  totalCents: ['expense', 'bill', 'payment', 'loan', 'income', 'adjustment'],
}

/** `a shift`, `an expense`. */
function withArticle(kind: TransactionKind): string {
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`
}

// These kinds also need the part named after them.
const OWN_PARTS = ['shift', 'bill', 'payment', 'adjustment'] as const

export function everyPersonId(input: TransactionTemplate): string[] {
  return [
    ...(input.payers ?? []).map((payer) => payer.personId),
    ...(input.split ? splitPersonIds(input.split) : []),
    ...(input.items ?? []).flatMap((item) => splitPersonIds(item.split)),
    ...(input.payment ? [input.payment.fromPersonId, input.payment.toPersonId] : []),
    ...(input.adjustment?.shares ?? []).map((share) => share.personId),
  ]
}

/**
 * The rules that depend on the transaction's kind. `path` is where the template's
 * fields sit inside the object being checked.
 */
export function checkKindRules(
  kind: TransactionKind,
  input: TransactionTemplate,
  ctx: z.RefinementCtx,
  path: string[] = [],
): void {
  const issue = (message: string, ...at: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path: [...path, ...at] })

  for (const part of Object.keys(PART_KINDS) as Part[]) {
    if (input[part] !== undefined && !PART_KINDS[part].includes(kind)) {
      issue(`Not allowed for ${withArticle(kind)}`, part)
    }
  }
  const ownPart = OWN_PARTS.find((part) => part === kind)
  if (ownPart && input[ownPart] === undefined) issue(`Required for ${withArticle(kind)}`, ownPart)
  // With items, the total is their sum.
  if (kind !== 'shift' && input.totalCents === undefined && input.items === undefined) {
    issue('Required unless the transaction has items', 'totalCents')
  }
  // ledger.md#splits: `days` splits are for bills only.
  if (kind !== 'bill') {
    if (input.split?.mode === 'days') issue('Only bills can split by days', 'split', 'mode')
    input.items?.forEach((item, index) => {
      if (item.split.mode === 'days')
        issue('Only bills can split by days', 'items', index, 'split', 'mode')
    })
  }
  // ledger.md#items-itemised-receipts: at most 15 people per transaction.
  if (new Set(everyPersonId(input)).size > MAX_PEOPLE_PER_TRANSACTION) {
    issue(`At most ${MAX_PEOPLE_PER_TRANSACTION} people per transaction`)
  }
}

// Checked on one-off transactions only: a schedule sets each occurrence's dueOn,
// and its template can't hold one billing period for every occurrence.
function checkOneOffBill({ bill, split, items }: TransactionTemplate, ctx: z.RefinementCtx): void {
  if (!bill) return
  // scheduling.md: reminders and autopay look at dueOn.
  if (bill.status === 'due' && bill.dueOn === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A due bill needs dueOn', path: ['bill', 'dueOn'] })
  }
  // ledger.md#days-present: days are counted within the billing period.
  const splits = [split, ...(items ?? []).map((item) => item.split)]
  const byDays = splits.some((spec) => spec?.mode === 'days')
  if (byDays && (bill.periodStart === undefined || bill.periodEnd === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A days split needs periodStart and periodEnd',
      path: ['bill'],
    })
  }
}

/** `POST /transactions`, and `PATCH /transactions/{id}` with the same `id`. */
export const transactionInputSchema = z
  .strictObject({
    id: idSchema,
    groupId: idSchema,
    kind: z.enum(TRANSACTION_KINDS),
    date: localDateSchema, // at most 1 year ahead: needs today, so the ledger function checks it
    description: descriptionSchema,
    ...transactionFields,
  })
  .superRefine((input, ctx) => {
    checkKindRules(input.kind, input, ctx)
    // On any other kind, `bill` is already reported as not allowed.
    if (input.kind === 'bill') checkOneOffBill(input, ctx)
  })

export type TransactionInput = z.infer<typeof transactionInputSchema>

/** `POST /transactions/{id}/post` */
export const postTransactionBodySchema = z.strictObject({
  date: localDateSchema.optional(),
  payers: transactionFields.payers,
  shift: z
    .strictObject({
      minutes: minutesSchema.optional(),
      rateCents: rateCentsSchema.optional(),
      breakMinutes: minutesSchema.optional(),
    })
    .optional(),
})

export type PostTransactionBody = z.infer<typeof postTransactionBodySchema>

/** `POST /transactions/{id}/void` */
export const voidTransactionBodySchema = z.strictObject({ reason: text(1, 200) })

export type VoidTransactionBody = z.infer<typeof voidTransactionBodySchema>

/** `POST /timer/start` */
export const startTimerBodySchema = z.strictObject({
  id: idSchema,
  groupId: idSchema,
  rateCents: rateCentsSchema.optional(),
  description: descriptionSchema.optional(),
})

export type StartTimerBody = z.infer<typeof startTimerBodySchema>

/** `POST /timer/stop` */
export const stopTimerBodySchema = z.strictObject({
  transactionId: idSchema,
  breakMinutes: minutesSchema.optional(),
})

export type StopTimerBody = z.infer<typeof stopTimerBodySchema>
