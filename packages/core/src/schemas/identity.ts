import { z } from 'zod'
import { MAX_HOURS_CAP_MINUTES, MIN_HOURS_CAP_MINUTES } from '../constants/limits'
import { isLocalDate, weekdayOf } from '../dates/local-date'
import type { Groups, Members, Profiles } from '../generated/rows'
import {
  currencySchema,
  displayNameSchema,
  emailSchema,
  idSchema,
  localDateSchema,
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

/**
 * The user's own work-hours limit (F-82, data-model.md#profiles): per week (Monday to Sunday),
 * or per fortnight counted from a Monday they pick. No visa or award rules: it only warns.
 */
export const hoursCapSchema = z
  .strictObject({
    minutes: z.int().min(MIN_HOURS_CAP_MINUTES),
    period: z.enum(['week', 'fortnight']),
    startsOn: localDateSchema.optional(),
  })
  .superRefine((cap, ctx) => {
    if (cap.minutes > MAX_HOURS_CAP_MINUTES[cap.period]) {
      ctx.addIssue({
        code: 'custom',
        path: ['minutes'],
        message: `At most ${MAX_HOURS_CAP_MINUTES[cap.period] / 60} hours a ${cap.period}`,
      })
    }
    if (cap.period === 'week') {
      if (cap.startsOn !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['startsOn'], message: 'A week has no start date' })
      }
    } else if (cap.startsOn === undefined) {
      ctx.addIssue({ code: 'custom', path: ['startsOn'], message: 'Required for a fortnight' })
    } else if (isLocalDate(cap.startsOn) && weekdayOf(cap.startsOn) !== 1) {
      // A date that isn't one is already refused by localDateSchema.
      ctx.addIssue({ code: 'custom', path: ['startsOn'], message: 'Must be a Monday' })
    }
  })

export type HoursCap = z.infer<typeof hoursCapSchema>

/** `PATCH /profile` */
export const updateProfileBodySchema = z.strictObject({
  displayName: displayNameSchema.optional(),
  timezone: timezoneSchema.optional(),
  region: regionSchema.optional(),
  currency: currencySchema.optional(),
  business: businessDetailsSchema.optional(),
  invoicePrefix: text(0, 16).optional(),
  summaryFrequency: z.enum(['none', 'weekly', 'fortnightly', 'monthly']).optional(),
  /** `null` clears it. */
  hoursCap: hoursCapSchema.nullable().optional(),
})

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>

/** `POST /invites`: sent only to the address the caller typed. */
export const createInviteBodySchema = z
  .strictObject({
    groupId: idSchema,
    memberId: idSchema,
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
  })
  .refine((invite) => (invite.email === undefined) !== (invite.phone === undefined), {
    message: 'Give exactly one of email or phone',
    path: ['email'],
  })

export type CreateInviteBody = z.infer<typeof createInviteBodySchema>

/**
 * `POST /invites/accept`. A malformed token is just an unknown one, so the
 * function answers INVITE_INVALID rather than this schema failing.
 */
export const acceptInviteBodySchema = z.strictObject({ token: z.string().max(128) })

export type AcceptInviteBody = z.infer<typeof acceptInviteBodySchema>

/**
 * `POST /account/delete` (#50, identity-and-invites.md#deleting-an-account-m4). Typing DELETE is
 * the confirmation; there is no undo.
 */
export const deleteAccountBodySchema = z.strictObject({ confirm: z.literal('DELETE') })

export type DeleteAccountBody = z.infer<typeof deleteAccountBodySchema>

// Responses (functions-api.md#identity), shared by the function and the web app. `PATCH /profile`
// returns the profile row itself.

/** `POST /bootstrap` */
export type BootstrapResult = {
  profile: Profiles
  personId: string
  personalGroupId: string
  linkedGroupIds: string[]
}

/** `POST /claim` */
export type ClaimResult = { linkedGroupIds: string[] }

/**
 * One group in `GET /groups/pending`: no more than its name, type and whether it's archived, and
 * for a pair group the other member's display name, since `name` is the creator's label for the
 * caller.
 */
export type PendingGroup = Pick<Groups, 'type' | 'name' | 'archivedAt'> & {
  id: string
  counterpartName?: string
}

/** `GET /groups/pending` */
export type PendingGroupsResult = { groups: PendingGroup[] }

/** `POST /groups/{id}/join` */
export type JoinGroupResult = { group: Groups; member: Members }

/**
 * `POST /account/delete`. `deletedAt` is the point of no return; with `finished: false`, the
 * hourly job deletes the rest.
 */
export type DeleteAccountResult = { deletedAt: string; finished: boolean }

/**
 * `details` of a refused `POST /account/delete`, which changes nothing: `FORBIDDEN` with `reauth`
 * when the session is older than REAUTH_WINDOW_MINUTES, or `VALIDATION_FAILED` with the houses
 * where the caller is the only joined admin and someone else is in the team.
 */
export type DeleteAccountRefusal = { reason: 'reauth' } | { groupIds: string[] }
