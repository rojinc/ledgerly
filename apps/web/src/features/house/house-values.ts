import type { Groups, Members } from '@ledgerly/core/generated/rows'
import {
  type addMemberBodySchema,
  type CreateGroupBody,
  type GroupSettings,
  groupSettingsSchema,
  type UpdateGroupBody,
  type updateMemberBodySchema,
} from '@ledgerly/core/schemas/groups'
import type { z } from 'zod'
import { type PlaceValues, placeOf, toPlaceBody } from '../profile/place-fields'
import { formatDate } from '../statements/invoice-view'

type HouseSettings = Extract<GroupSettings, { type: 'house' }>

/** The house form's fields: new house and settings (functions-api.md#groups). */
export type HouseValues = PlaceValues & {
  name: string
  defaultBillSplit: HouseSettings['defaultBillSplit']
  /** "Close each month with a divide": `statementCycle` monthly, else none (statements.md). */
  monthlyDivide: boolean
  autoFinalize: boolean
}

/** A new house's defaults. Time zone, region and currency start as the profile's (F-10). */
export const NEW_HOUSE: Omit<HouseValues, keyof PlaceValues> = {
  name: '',
  defaultBillSplit: 'days',
  monthlyDivide: true,
  autoFinalize: false,
}

/** The group fields the house form holds, as `POST` and `PATCH /groups` take them. */
export function toHouseFields(values: HouseValues) {
  return {
    name: values.name.trim(),
    ...toPlaceBody(values),
    statementCycle: values.monthlyDivide ? ('monthly' as const) : ('none' as const),
    settings: {
      type: 'house' as const,
      autoFinalize: values.autoFinalize,
      defaultBillSplit: values.defaultBillSplit,
    },
  }
}

/** `groups POST /groups` for a house, with a client ID so a retry is safe. */
export function toNewHouseBody(values: HouseValues, id: string): CreateGroupBody {
  return { id, type: 'house', ...toHouseFields(values) }
}

/**
 * `groups PATCH /groups/{id}` with only what the settings form changed, so a save doesn't undo
 * another admin's change to the rest. `settings` is one value, so the half the form didn't
 * change comes from `stored`: the house as it's stored now.
 */
export function toHouseSettingsBody(
  values: HouseValues,
  changed: Partial<Record<keyof HouseValues, boolean>>,
  stored: HouseValues,
): UpdateGroupBody {
  const pick = <K extends keyof HouseValues>(key: K) => (changed[key] ? values[key] : stored[key])
  const fields = toHouseFields({
    name: pick('name'),
    timezone: pick('timezone'),
    region: pick('region'),
    currency: pick('currency'),
    defaultBillSplit: pick('defaultBillSplit'),
    monthlyDivide: pick('monthlyDivide'),
    autoFinalize: pick('autoFinalize'),
  })
  return {
    ...(changed.name ? { name: fields.name } : {}),
    ...(changed.timezone ? { timezone: fields.timezone } : {}),
    ...(changed.region ? { region: fields.region } : {}),
    ...(changed.currency ? { currency: fields.currency } : {}),
    ...(changed.monthlyDivide ? { statementCycle: fields.statementCycle } : {}),
    ...(changed.defaultBillSplit || changed.autoFinalize ? { settings: fields.settings } : {}),
  }
}

/**
 * The settings form's values for a stored house, or undefined when its settings can't be read:
 * the form would show defaults, and a save would overwrite what's stored.
 */
export function toHouseValues(group: Groups): HouseValues | undefined {
  try {
    const settings = groupSettingsSchema.safeParse(JSON.parse(group.settingsJson))
    if (!settings.success || settings.data.type !== 'house') return undefined
    return {
      name: group.name,
      ...placeOf(group),
      defaultBillSplit: settings.data.defaultBillSplit,
      monthlyDivide: group.statementCycle === 'monthly',
      autoFinalize: settings.data.autoFinalize,
    }
  } catch {
    return undefined
  }
}

/** The add-housemate form's fields, as typed. */
export type HousemateValues = {
  displayName: string
  email: string
  phone: string
  role: Members['role']
  joinedOn: string
}

/**
 * `groups POST /groups/{id}/members`. Only an admin picks the role; a member adds people with the
 * default role (permissions.md#roles), so theirs is left out.
 */
export function toAddHousemateBody(
  values: HousemateValues,
  isAdmin: boolean,
): z.input<typeof addMemberBodySchema> {
  const email = values.email.trim()
  const phone = values.phone.trim()
  return {
    displayName: values.displayName.trim(),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(isAdmin ? { role: values.role } : {}),
    joinedOn: values.joinedOn,
  }
}

/** The edit-member form's fields (admins). */
export type MemberEditValues = { displayName: string; role: Members['role']; joinedOn: string }

/** `PATCH /groups/{id}/members/{memberId}` with only what changed, so a retry is a no-op. */
export function toMemberEditBody(
  values: MemberEditValues,
  stored: Members,
): z.input<typeof updateMemberBodySchema> {
  const displayName = values.displayName.trim()
  return {
    ...(displayName !== stored.displayName ? { displayName } : {}),
    ...(values.role !== stored.role ? { role: values.role } : {}),
    ...(values.joinedOn !== stored.joinedOn ? { joinedOn: values.joinedOn } : {}),
  }
}

/**
 * `PATCH { leftOn: null }`: someone who moved out lives here again (permissions.md#leaving-a-group).
 * The function keeps their role unless the body names one, so a new role goes with it.
 */
export function toMoveBackInBody(
  role: Members['role'],
  stored: Members,
): z.input<typeof updateMemberBodySchema> {
  return { leftOn: null, ...(role !== stored.role ? { role } : {}) }
}

export const ROLE_LABEL: Record<Members['role'], string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

/**
 * Where someone stands, in words: "Not joined yet" for a placeholder, then their move-in or
 * move-out date. A placeholder looks the same whether or not they have an account (D-016).
 */
export function memberStatusText(member: Pick<Members, 'status' | 'joinedOn' | 'leftOn'>): string {
  const dates = member.leftOn
    ? `Moved out ${formatDate(member.leftOn)}`
    : `Moved in ${formatDate(member.joinedOn)}`
  return member.status === 'placeholder' ? `Not joined yet · ${dates}` : dates
}

/**
 * A refused `DELETE` on a housemate, in words: the function keeps anyone with shares, or named in
 * an unposted transaction or a schedule (functions-api.md#groups). The page never offers to
 * remove yourself, so its other reason, the last joined admin, can't come up.
 */
export const REMOVE_REFUSED =
  'They have money or a schedule in this house. Mark them as moved out instead.'
