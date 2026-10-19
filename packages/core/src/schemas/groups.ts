import { z } from 'zod'
import { ROLES } from '../constants/domain'
import type { Groups, Members } from '../generated/rows'
import {
  checkDateOrder,
  currencySchema,
  displayNameSchema,
  emailSchema,
  idSchema,
  localDateSchema,
  phoneSchema,
  rateCentsSchema,
  regionSchema,
  text,
  timezoneSchema,
} from './common'

// functions-api.md#groups and data-model.md#groups.

// Invoices are emailed to every recipient, so a short list keeps the app from
// becoming a way to send bulk email.
const MAX_RECIPIENTS = 10
const MAX_PAYMENT_TERMS_DAYS = 365

export const statementCycleSchema = z.enum(['none', 'weekly', 'fortnightly', 'monthly'])

/** `groups.settingsJson` */
export const groupSettingsSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('employer'),
    defaultRateCents: rateCentsSchema,
    paymentTermsDays: z.int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
    autoFinalize: z.boolean(),
    recipients: z.array(emailSchema).max(MAX_RECIPIENTS), // billing emails
  }),
  z.strictObject({
    type: z.literal('house'),
    autoFinalize: z.boolean(),
    defaultBillSplit: z.enum(['days', 'equal']),
  }),
  z.strictObject({ type: z.literal('personal') }),
  z.strictObject({ type: z.literal('pair') }),
])

export type GroupSettings = z.infer<typeof groupSettingsSchema>

const groupFields = {
  name: text(1, 100),
  currency: currencySchema.optional(),
  timezone: timezoneSchema.optional(),
  region: regionSchema.optional(),
  statementCycle: statementCycleSchema.optional(),
  cycleAnchor: localDateSchema.optional(),
  settings: groupSettingsSchema.optional(),
}

/** `POST /groups`. Personal groups are made by bootstrap, never here. */
export const createGroupBodySchema = z
  .strictObject({
    id: idSchema,
    type: z.enum(['house', 'employer', 'pair']),
    ...groupFields,
    counterpart: z
      .strictObject({
        displayName: displayNameSchema,
        email: emailSchema.optional(),
        phone: phoneSchema.optional(),
      })
      .optional(),
  })
  .superRefine((group, ctx) => {
    // Employer and pair groups always have exactly two members.
    const needsCounterpart = group.type !== 'house'
    if (needsCounterpart !== (group.counterpart !== undefined)) {
      const message = needsCounterpart
        ? `Required for ${group.type === 'employer' ? 'an' : 'a'} ${group.type} group`
        : 'Only employer and pair groups have a counterpart'
      ctx.addIssue({ code: 'custom', message, path: ['counterpart'] })
    }
    // periodFor() counts weekly and fortnightly periods from the anchor.
    const counted = group.statementCycle === 'weekly' || group.statementCycle === 'fortnightly'
    if (counted && group.cycleAnchor === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `A ${group.statementCycle} cycle needs cycleAnchor`,
        path: ['cycleAnchor'],
      })
    }
    if (group.settings && group.settings.type !== group.type) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must match the group type',
        path: ['settings', 'type'],
      })
    }
  })

export type CreateGroupBody = z.infer<typeof createGroupBodySchema>

/**
 * `PATCH /groups/{id}`. The function checks `settings.type` and the cycle anchor
 * against the stored group.
 */
export const updateGroupBodySchema = z.strictObject({
  ...groupFields,
  name: groupFields.name.optional(),
})

export type UpdateGroupBody = z.infer<typeof updateGroupBodySchema>

/** `POST /groups/{id}/members` */
export const addMemberBodySchema = z.strictObject({
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  role: z.enum(ROLES).optional(),
  joinedOn: localDateSchema.optional(),
})

export type AddMemberBody = z.infer<typeof addMemberBodySchema>

/** `PATCH /groups/{id}/members/{memberId}` */
export const updateMemberBodySchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    role: z.enum(ROLES).optional(),
    joinedOn: localDateSchema.optional(),
    // `null` clears it: someone who moved out moves back in (permissions.md#leaving-a-group).
    leftOn: localDateSchema.nullable().optional(),
  })
  .superRefine((member, ctx) =>
    checkDateOrder(member.joinedOn, member.leftOn ?? undefined, 'leftOn', ctx),
  )

export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>

// Responses (functions-api.md#groups), shared by the function and the web app. `PATCH` and
// `/archive` return the group row itself.

/** `POST /groups` */
export type CreateGroupResult = { group: Groups; members: Members[] }
