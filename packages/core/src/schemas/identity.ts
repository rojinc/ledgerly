import { z } from 'zod'
import {
  currencySchema,
  displayNameSchema,
  emailSchema,
  idSchema,
  phoneSchema,
  regionSchema,
  text,
  timezoneSchema,
} from './common'

// functions-api.md#identity and data-model.md#profiles.

/** Digits only, after dropping the spaces and dashes people type (`062-000` → `062000`). */
function digits(min: number, max: number) {
  return z
    .string()
    .transform((value) => value.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(new RegExp(`^\\d{${min},${max}}$`), `Expected ${min}–${max} digits`))
}

/** `profiles.businessJson`, printed on invoices. */
export const businessDetailsSchema = z.strictObject({
  businessName: text(1, 100).optional(),
  abn: digits(11, 11).optional(),
  address: text(1, 300).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  bank: z
    .strictObject({
      accountName: text(1, 100),
      bsb: digits(6, 6),
      accountNumber: digits(1, 12),
    })
    .optional(),
  payId: text(1, 100).optional(),
  invoiceNotes: text(1, 1000).optional(),
})

export type BusinessDetails = z.infer<typeof businessDetailsSchema>

/** `POST /bootstrap` */
export const bootstrapBodySchema = z.strictObject({ timezone: timezoneSchema })

export type BootstrapBody = z.infer<typeof bootstrapBodySchema>

/** `PATCH /profile` */
export const updateProfileBodySchema = z.strictObject({
  displayName: displayNameSchema.optional(),
  timezone: timezoneSchema.optional(),
  region: regionSchema.optional(),
  currency: currencySchema.optional(),
  business: businessDetailsSchema.optional(),
  invoicePrefix: text(0, 16).optional(),
  summaryFrequency: z.enum(['none', 'weekly', 'fortnightly', 'monthly']).optional(),
})

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>

/** `POST /invites` */
export const createInviteBodySchema = z.strictObject({
  groupId: idSchema,
  memberId: idSchema,
  channel: z.enum(['email', 'sms']),
})

export type CreateInviteBody = z.infer<typeof createInviteBodySchema>

/** `POST /invites/accept`. The token is 32 random bytes as base64url. */
export const acceptInviteBodySchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Not an invite token'),
})

export type AcceptInviteBody = z.infer<typeof acceptInviteBodySchema>
