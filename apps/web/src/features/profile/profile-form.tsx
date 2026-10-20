import type { Profiles } from '@ledgerly/core/generated/rows'
import { type UpdateProfileBody, updateProfileBodySchema } from '@ledgerly/core/schemas/identity'
import { useForm } from 'react-hook-form'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { SelectField, TextField } from '../../ui/field'
import { PlaceFields, type PlaceValues, toPlaceBody } from './place-fields'

export type ProfileValues = PlaceValues & {
  displayName: string
  summaryFrequency: NonNullable<UpdateProfileBody['summaryFrequency']>
}

export function toProfileBody(values: ProfileValues): UpdateProfileBody {
  return {
    displayName: values.displayName,
    ...toPlaceBody(values),
    summaryFrequency: values.summaryFrequency,
  }
}

const SUMMARY_OPTIONS = [
  ['none', 'Never'],
  ['weekly', 'Weekly'],
  ['fortnightly', 'Fortnightly'],
  ['monthly', 'Monthly'],
] as const

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
          // Show what was stored (trimmed, upper-cased), not what was typed.
          form.reset(body as ProfileValues)
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
      <PlaceFields register={form.register} errors={errors} zone={profile.timezone} />
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
