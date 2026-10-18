import { z } from 'zod'
import {
  centsSchema,
  checkDateOrder,
  currencySchema,
  idSchema,
  localDateSchema,
  text,
} from './common'
import { businessDetailsSchema } from './identity'

// functions-api.md#statements and statements.md#snapshot.

// Balances add up many amounts, so they may go past MAX_AMOUNT_CENTS.
const balanceCentsSchema = z.int()

const shareAmountsSchema = z.strictObject({
  personId: idSchema,
  givenCents: centsSchema,
  receivedCents: centsSchema,
})

/**
 * `statements.snapshotJson`: a historical record, never rewritten. `kind` and
 * `category` stay plain strings so old snapshots still parse if those lists change.
 */
export const statementSnapshotSchema = z.strictObject({
  version: z.literal(1),
  group: z.strictObject({
    id: idSchema,
    name: z.string(),
    type: z.enum(['employer', 'house']),
    currency: currencySchema,
    timezone: z.string(),
  }),
  period: z.strictObject({ start: localDateSchema, end: localDateSchema }),
  issuer: z // invoices
    .strictObject({ personId: idSchema, name: z.string(), business: businessDetailsSchema })
    .optional(),
  recipient: z // invoices
    .strictObject({ personId: idSchema, name: z.string(), emails: z.array(z.string()) })
    .optional(),
  people: z.array(
    z.strictObject({
      personId: idSchema,
      name: z.string(),
      openingCents: balanceCentsSchema,
      givenCents: balanceCentsSchema,
      receivedCents: balanceCentsSchema,
      closingCents: balanceCentsSchema,
    }),
  ),
  lines: z.array(
    z.strictObject({
      transactionId: idSchema,
      date: localDateSchema,
      kind: z.string(),
      description: z.string(),
      category: z.string().optional(),
      totalCents: centsSchema,
      shift: z.strictObject({ minutes: z.int(), rateCents: z.int() }).optional(),
      shares: z.array(shareAmountsSchema),
    }),
  ),
  // Divides: the suggested settle-up.
  transfers: z.array(
    z.strictObject({ fromPersonId: idSchema, toPersonId: idSchema, cents: z.int().positive() }),
  ),
  invoice: z
    .strictObject({
      balanceDueCents: balanceCentsSchema,
      paymentTermsDays: z.int(),
      dueOn: localDateSchema.optional(),
    })
    .optional(),
  generatedAt: z.iso.datetime(), // UTC instant
})

export type StatementSnapshot = z.infer<typeof statementSnapshotSchema>

/** `POST /statements/preview` */
export const previewStatementBodySchema = z.strictObject({
  groupId: idSchema,
  periodEnd: localDateSchema.optional(),
})

export type PreviewStatementBody = z.infer<typeof previewStatementBodySchema>

/** `POST /statements/{id}/finalize` */
export const finalizeStatementBodySchema = z.strictObject({ send: z.boolean() })

export type FinalizeStatementBody = z.infer<typeof finalizeStatementBodySchema>

/** `POST /statements/{id}/void` */
export const voidStatementBodySchema = z.strictObject({ reason: text(1, 200) })

export type VoidStatementBody = z.infer<typeof voidStatementBodySchema>

/** `POST /statements/reissue` */
export const reissueStatementBodySchema = z
  .strictObject({ groupId: idSchema, periodStart: localDateSchema, periodEnd: localDateSchema })
  .superRefine((body, ctx) => checkDateOrder(body.periodStart, body.periodEnd, 'periodEnd', ctx))

export type ReissueStatementBody = z.infer<typeof reissueStatementBodySchema>
