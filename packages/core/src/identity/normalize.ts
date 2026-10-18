import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js/min'
import type { IdentitiesType } from '../generated/rows'
import { emailSchema } from '../schemas/common'

// identity-and-invites.md#normalising-identities: one canonical key per email or
// phone number, so one person never becomes two. Errors never repeat the input,
// so they are safe to log.

/** Trims and lowercases an email; dots and `+tags` are kept. */
export function normalizeEmail(raw: string): string {
  const email = emailSchema.safeParse(raw)
  if (!email.success) throw new RangeError('Not an email address')
  return email.data.toLowerCase()
}

/**
 * Parses a phone number into E.164, e.g. `normalizePhone('0412 345 678', 'AU')` →
 * `+61412345678`. `defaultCountry` is for numbers typed without a country code:
 * an ISO country, or a holiday region such as `AU-NSW` (its country is used).
 */
export function normalizePhone(raw: string, defaultCountry?: string): string {
  const country = defaultCountry?.slice(0, 2) as CountryCode | undefined
  const phone = parsePhoneNumberFromString(raw, country)
  // An extension can't receive an SMS, and dropping it would turn two numbers into
  // one. With min metadata, territories sharing a calling code (+1 for PR, +39 for
  // VA) check a national number more loosely than its E.164 form, so that form must
  // be valid too: then identityKey() accepts whatever this returns.
  const valid =
    phone?.isValid() && !phone.ext && parsePhoneNumberFromString(phone.number)?.isValid()
  if (!phone || !valid) throw new RangeError('Not a valid phone number')
  return phone.number
}

/**
 * The `identities.key` for a normalized email or an E.164 phone number, e.g.
 * `email:sam@example.com` or `phone:+61412345678`. It normalizes the value again,
 * which changes nothing for those, so the key is always canonical.
 */
export function identityKey(type: IdentitiesType, value: string): string {
  return type === 'email' ? `email:${normalizeEmail(value)}` : `phone:${normalizePhone(value)}`
}
