import type { FieldError, UseFormRegisterReturn } from 'react-hook-form'
import { SelectField, TextField } from '../../ui/field'

/** A profile's time zone, public holiday region and currency, and a group's own (F-10). */
export type PlaceValues = { timezone: string; region: string; currency: string }

/** The three fields of a profile or group row. */
export function placeOf({ timezone, region, currency }: PlaceValues): PlaceValues {
  return { timezone, region, currency }
}

/** As the functions take them: region and currency upper-cased. */
export function toPlaceBody(values: PlaceValues): PlaceValues {
  return {
    timezone: values.timezone,
    region: values.region.trim().toUpperCase(),
    currency: values.currency.trim().toUpperCase(),
  }
}

function timeZones(current: string): string[] {
  // Some browsers leave UTC out of this list, and older ones don't have it at all.
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return zones.includes(current) ? zones : [current, ...zones]
}

type Props = {
  register: (name: keyof PlaceValues) => UseFormRegisterReturn
  errors: Partial<Record<keyof PlaceValues, FieldError>>
  /** The stored time zone, listed even where the browser doesn't know it. */
  zone: string
  /** A group's own, new or saved: says what a change can't do (functions-api.md#groups). */
  group?: 'new' | 'saved'
}

export function PlaceFields({ register, errors, zone, group }: Props) {
  return (
    <>
      <SelectField
        id="timezone"
        label="Time zone"
        // statements.md#periods: a period that's due stays as it was (#126).
        hint={group === 'saved' ? 'A period that has already ended keeps its dates.' : undefined}
        error={errors.timezone}
        {...register('timezone')}
      >
        {timeZones(zone).map((name) => (
          <option key={name} value={name}>
            {name.replaceAll('_', ' ')}
          </option>
        ))}
      </SelectField>
      <TextField
        id="region"
        label="Public holiday region"
        hint="Country and state, e.g. AU-NSW."
        autoCapitalize="characters"
        error={errors.region}
        {...register('region')}
      />
      <TextField
        id="currency"
        label="Currency"
        hint={
          group
            ? 'Three letters, e.g. AUD. It can’t change once something is recorded.'
            : 'Three letters, e.g. AUD.'
        }
        autoCapitalize="characters"
        maxLength={3}
        error={errors.currency}
        {...register('currency')}
      />
    </>
  )
}
