import { z } from 'zod'
import {
  centsSchema,
  checkDateOrder,
  currencySchema,
  idSchema,
  localDateSchema,
  text,
} from './common'

// functions-api.md#statements and statements.md#snapshot.

// Balances add up many amounts, so they may go past MAX_AMOUNT_CENTS.
const balanceCentsSchema = z.int()

/**
 * The issuer's business details as an invoice's snapshot keeps them: the Profile's fields
 * (`businessDetailsSchema`), each as plain text, so a stored snapshot still parses whatever the
 * Profile's rules later become (#543). A field added to the Profile is added here too, optional.
 * One the Profile drops or renames stays here, optional, since final invoices hold it for good
 * (#556). The bank is whole or absent, since an invoice prints its three parts together.
 */
export const snapshotBusinessSchema = z.strictObject({
  businessName: z.string().optional(),
  abn: z.string().optional(),
  address: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  bank: z
    .strictObject({ accountName: z.string(), bsb: z.string(), accountNumber: z.string() })
    .optional(),
  payId: z.string().optional(),
  invoiceNotes: z.string().optional(),
})

export type SnapshotBusiness = z.infer<typeof snapshotBusinessSchema>

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
    .strictObject({ personId: idSchema, name: z.string(), business: snapshotBusinessSchema })
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

/** `POST /statements/close` (statements.md#6-close-a-period-now-post-statementsclose). */
export const closeStatementBodySchema = z.strictObject({
  groupId: idSchema,
  periodEnd: localDateSchema.optional(),
})

export type CloseStatementBody = z.infer<typeof closeStatementBodySchema>

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
