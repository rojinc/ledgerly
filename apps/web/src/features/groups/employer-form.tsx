import { parseMoney } from '@ledgerly/core/money/format'
import {
  type CreateGroupBody,
  createGroupBodySchema,
  type GroupSettings,
  type UpdateGroupBody,
  updateGroupBodySchema,
} from '@ledgerly/core/schemas/groups'
import { type FieldError, type FieldErrors, get, type Resolver, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, SelectField, TextField } from '../../ui/field'

type Cycle = NonNullable<CreateGroupBody['statementCycle']>
type EmployerSettings = Extract<GroupSettings, { type: 'employer' }>

export type EmployerValues = {
  name: string
  recipients: string
  defaultRate: string
  statementCycle: Cycle
  cycleAnchor: string
  paymentTermsDays: string
  autoFinalize: boolean
}

const CYCLE_OPTIONS = [
  ['monthly', 'Monthly'],
  ['fortnightly', 'Fortnightly'],
  ['weekly', 'Weekly'],
  ['none', 'No regular invoices'],
] as const

/** Defaults for a group stored without settings (data-model.md#groups). */
const EMPLOYER_DEFAULTS: EmployerSettings = {
  type: 'employer',
  defaultRateCents: 0,
  paymentTermsDays: 14,
  autoFinalize: false,
  recipients: [],
}

/** Weekly and fortnightly periods are counted from the anchor (statements.md#periods). */
function hasAnchor(cycle: Cycle): boolean {
  return cycle === 'weekly' || cycle === 'fortnightly'
}

/** Billing emails typed one per line or separated by commas, without empty entries. */
export function splitRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean)
}

function decimals(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits as number
}

/** Cents as plain text for an input, with string maths only: 2550 AUD → `25.50`, 2550 JPY → `2550`. */
export function centsToText(cents: number, currency: string): string {
  const digits = decimals(currency)
  const sign = cents < 0 ? '-' : ''
  const units = String(Math.abs(cents)).padStart(digits + 1, '0')
  const whole = units.slice(0, units.length - digits)
  return digits > 0 ? `${sign}${whole}.${units.slice(units.length - digits)}` : `${sign}${whole}`
}

/** NaN makes the schema reject the rate; employerResolver then explains why. */
function rateCents(text: string, currency: string): number {
  try {
    return parseMoney(text, currency)
  } catch {
    return Number.NaN
  }
}

function toSettings(values: EmployerValues, currency: string): EmployerSettings {
  const days = values.paymentTermsDays.trim()
  return {
    type: 'employer',
    defaultRateCents: rateCents(values.defaultRate, currency),
    paymentTermsDays: /^\d+$/.test(days) ? Number(days) : Number.NaN,
    autoFinalize: values.autoFinalize,
    recipients: splitRecipients(values.recipients),
  }
}

function cycleFields(values: EmployerValues) {
  return {
    statementCycle: values.statementCycle,
    ...(hasAnchor(values.statementCycle) && values.cycleAnchor
      ? { cycleAnchor: values.cycleAnchor }
      : {}),
  }
}

/** `POST /groups` for a new employer. The group is named after the employer. */
export function toCreateBody(
  values: EmployerValues,
  currency: string,
  id: string,
): z.input<typeof createGroupBodySchema> {
  return {
    id,
    type: 'employer',
    name: values.name,
    currency,
    counterpart: { displayName: values.name },
    ...cycleFields(values),
    settings: toSettings(values, currency),
  }
}

/** `PATCH /groups/{id}`. */
export function toUpdateBody(
  values: EmployerValues,
  currency: string,
): z.input<typeof updateGroupBodySchema> {
  return { name: values.name, ...cycleFields(values), settings: toSettings(values, currency) }
}

type StoredGroup = {
  name?: string
  statementCycle?: Cycle
  cycleAnchor?: string | null
  settings?: GroupSettings
}

/** Form values for a stored group or a saved body. Other settings types get the defaults. */
export function toEmployerValues(group: StoredGroup, currency: string): EmployerValues {
  const settings = group.settings?.type === 'employer' ? group.settings : EMPLOYER_DEFAULTS
  return {
    name: group.name ?? '',
    recipients: settings.recipients.join('\n'),
    defaultRate: centsToText(settings.defaultRateCents, currency),
    statementCycle: group.statementCycle ?? 'monthly',
    cycleAnchor: group.cycleAnchor ?? '',
    paymentTermsDays: String(settings.paymentTermsDays),
    autoFinalize: settings.autoFinalize,
  }
}

function recipientsError(node: unknown, values: EmployerValues): string {
  // A message on the list itself is its length; otherwise one address is wrong.
  if ((node as FieldError).message !== undefined) return 'At most 10 billing emails'
  const index = (node as unknown[]).findIndex(Boolean)
  return `${splitRecipients(values.recipients)[index]} is not an email address`
}

/**
 * The shared schema's errors, moved from body paths (`settings.defaultRateCents`) to
 * the inputs that hold them (`defaultRate`), with wording for people.
 */
export function employerResolver<TBody>(
  schema: z.ZodType<TBody>,
  toBody: (values: EmployerValues) => unknown,
  currency: string,
): Resolver<EmployerValues, unknown, TBody> {
  const resolve = schemaResolver<EmployerValues, TBody>(schema, toBody)
  return async (values, context, options) => {
    const result = await resolve(values, context, options)
    const found = result.errors as FieldErrors
    const errors: Record<string, { type: string; message: string }> = {}
    const add = (field: keyof EmployerValues, message: string | undefined) => {
      if (message && !errors[field]) errors[field] = { type: 'validate', message }
    }
    add(
      'name',
      (get(found, 'name') ?? get(found, 'counterpart.displayName'))?.message as string | undefined,
    )
    const recipients = get(found, 'settings.recipients')
    if (recipients) add('recipients', recipientsError(recipients, values))
    if (get(found, 'settings.defaultRateCents')) {
      const example = centsToText(2550, currency)
      add(
        'defaultRate',
        values.defaultRate.trim() === ''
          ? 'Required'
          : Number.isNaN(rateCents(values.defaultRate, currency))
            ? `Enter an amount like ${example}`
            : 'Must be 0 or more',
      )
    }
    if (get(found, 'settings.paymentTermsDays')) {
      add('paymentTermsDays', 'Enter whole days, 0 to 365')
    }
    // The PATCH schema can't check the anchor (the function does, against the stored group).
    if (hasAnchor(values.statementCycle) && !values.cycleAnchor) add('cycleAnchor', 'Required')
    add('cycleAnchor', get(found, 'cycleAnchor')?.message)
    if (Object.keys(found).length > 0 && Object.keys(errors).length === 0) {
      errors.root = { type: 'validate', message: 'Something in the form is not valid.' }
    }
    if (Object.keys(errors).length === 0) return result
    return { values: {}, errors: errors as FieldErrors<EmployerValues> }
  }
}

type Props = {
  currency: string
  defaultValues: EmployerValues
  /** Shows the settings without a way to change them. */
  readOnly?: boolean
} & (
  | { mode: 'create'; id: string; onSave: (body: CreateGroupBody) => Promise<unknown> }
  | {
      mode: 'settings'
      /** Resolves to the values of the group as stored. */
      onSave: (body: UpdateGroupBody) => Promise<EmployerValues>
    }
)

const TEXTAREA =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive'

export function EmployerForm(props: Props) {
  const { currency, defaultValues, readOnly = false } = props
  const form = useForm<EmployerValues, unknown, CreateGroupBody | UpdateGroupBody>({
    resolver:
      props.mode === 'create'
        ? employerResolver<CreateGroupBody | UpdateGroupBody>(
            createGroupBodySchema,
            (values) => toCreateBody(values, currency, props.id),
            currency,
          )
        : employerResolver<CreateGroupBody | UpdateGroupBody>(
            updateGroupBodySchema,
            (values) => toUpdateBody(values, currency),
            currency,
          ),
    defaultValues,
  })
  const { errors, isDirty, isSubmitting, isSubmitSuccessful } = form.formState
  const cycle = form.watch('statementCycle')

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (body) => {
        try {
          if (props.mode === 'create') {
            await props.onSave(body as CreateGroupBody)
          } else {
            // Show what was stored (trimmed, one email per line, the kept anchor), not what was typed.
            form.reset(await props.onSave(body as UpdateGroupBody))
          }
        } catch (error) {
          form.setError('root', { message: (error as Error).message })
        }
      })}
      className="flex flex-col gap-4"
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
        <TextField
          id="name"
          label={props.mode === 'create' ? 'Employer name' : 'Group name'}
          autoComplete="organization"
          error={errors.name}
          {...form.register('name')}
        />
        <Field
          id="recipients"
          label="Billing emails"
          hint="Invoices go to these addresses. One per line, or separated by commas."
          error={errors.recipients}
        >
          {(aria) => (
            <textarea
              rows={3}
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              className={TEXTAREA}
              {...form.register('recipients')}
              {...aria}
            />
          )}
        </Field>
        <TextField
          id="defaultRate"
          label={`Default hourly rate (${currency})`}
          inputMode="decimal"
          error={errors.defaultRate}
          {...form.register('defaultRate')}
        />
        <SelectField
          id="statementCycle"
          label="Invoice cycle"
          error={errors.statementCycle}
          {...form.register('statementCycle')}
        >
          {CYCLE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        {hasAnchor(cycle) && (
          <TextField
            id="cycleAnchor"
            label="Cycle starts on"
            type="date"
            hint="First day of the first period."
            error={errors.cycleAnchor}
            {...form.register('cycleAnchor')}
          />
        )}
        <TextField
          id="paymentTermsDays"
          label="Payment terms (days)"
          inputMode="numeric"
          error={errors.paymentTermsDays}
          {...form.register('paymentTermsDays')}
        />
        <div className="flex items-start gap-3">
          <input
            id="autoFinalize"
            type="checkbox"
            className="mt-0.5 size-5 shrink-0 accent-primary"
            {...form.register('autoFinalize')}
          />
          <label htmlFor="autoFinalize" className="text-sm">
            Finalize invoices automatically when the period ends
          </label>
        </div>
      </fieldset>
      {!readOnly && (
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : props.mode === 'create' ? 'Create employer' : 'Save'}
        </Button>
      )}
      {props.mode === 'settings' && isSubmitSuccessful && !isDirty && !errors.root && (
        <Alert>Saved.</Alert>
      )}
    </form>
  )
}
