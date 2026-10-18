import type { Profiles } from '@ledgerly/core/generated/rows'
import { type UpdateProfileBody, updateProfileBodySchema } from '@ledgerly/core/schemas/identity'
import { useForm } from 'react-hook-form'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from './field'
import { schemaResolver } from './schema-resolver'

export type ProfileValues = {
  displayName: string
  timezone: string
  region: string
  currency: string
  summaryFrequency: NonNullable<UpdateProfileBody['summaryFrequency']>
}

export function toProfileBody(values: ProfileValues): UpdateProfileBody {
  return {
    displayName: values.displayName,
    timezone: values.timezone,
    region: values.region.trim().toUpperCase(),
    currency: values.currency.trim().toUpperCase(),
    summaryFrequency: values.summaryFrequency,
  }
}

const SUMMARY_OPTIONS = [
  ['none', 'Never'],
  ['weekly', 'Weekly'],
  ['fortnightly', 'Fortnightly'],
  ['monthly', 'Monthly'],
] as const

function timeZones(current: string): string[] {
  // Some browsers leave UTC out of this list, and older ones don't have it at all.
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return zones.includes(current) ? zones : [current, ...zones]
}

type Props = {
  profile: Profiles
  displayName: string
  onSave: (body: UpdateProfileBody) => Promise<unknown>
}

export function ProfileForm({ profile, displayName, onSave }: Props) {
  const form = useForm<ProfileValues, unknown, UpdateProfileBody>({
    resolver: schemaResolver(updateProfileBodySchema, toProfileBody),
    defaultValues: {
      displayName,
      timezone: profile.timezone,
      region: profile.region,
      currency: profile.currency,
      summaryFrequency: profile.summaryFrequency,
    },
  })
  const { errors, isDirty, isSubmitting, isSubmitSuccessful } = form.formState

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (body) => {
        try {
          await onSave(body)
          form.reset(form.getValues())
        } catch (error) {
          form.setError('root', { message: (error as Error).message })
        }
      })}
      className="flex flex-col gap-4"
      aria-labelledby="profile-heading"
    >
      <h2 id="profile-heading" className="text-lg font-semibold">
        You
      </h2>
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id="displayName"
        label="Name"
        autoComplete="name"
        error={errors.displayName}
        {...form.register('displayName')}
      />
      <SelectField
        id="timezone"
        label="Time zone"
        error={errors.timezone}
        {...form.register('timezone')}
      >
        {timeZones(profile.timezone).map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll('_', ' ')}
          </option>
        ))}
      </SelectField>
      <TextField
        id="region"
        label="Public holiday region"
        hint="Country and state, e.g. AU-NSW."
        autoCapitalize="characters"
        error={errors.region}
        {...form.register('region')}
      />
      <TextField
        id="currency"
        label="Currency"
        hint="Three letters, e.g. AUD."
        autoCapitalize="characters"
        maxLength={3}
        error={errors.currency}
        {...form.register('currency')}
      />
      <SelectField
        id="summaryFrequency"
        label="Summary email"
        error={errors.summaryFrequency}
        {...form.register('summaryFrequency')}
      >
        {SUMMARY_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Save'}
      </Button>
      {isSubmitSuccessful && !isDirty && !errors.root && <Alert>Saved.</Alert>}
    </form>
  )
}
