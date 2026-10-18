import { z } from 'zod'
import { CATEGORIES } from '../constants/categories'
import { MAX_AMOUNT_CENTS, MAX_PEOPLE_PER_TRANSACTION } from '../constants/limits'

// Building blocks shared by the route schemas (functions-api.md#shared-types).

/** An Appwrite ID: up to 36 of `a-z A-Z 0-9 . - _`, not starting with a special character. */
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/, 'Not an ID')

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

// An impossible date like 02-30 rolls over to 03-02 and no longer matches. Counted
// in UTC so the machine's timezone never matters (D-005).
// simple: swap for isLocalDate from dates/local-date.ts once #6 merges.
function isLocalDate(text: string): boolean {
  if (!LOCAL_DATE.test(text)) return false
  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** A calendar date as `YYYY-MM-DD` in the group's timezone. */
export const localDateSchema = z.string().refine(isLocalDate, 'Expected a calendar date YYYY-MM-DD')

export const categorySchema = z.enum(CATEGORIES)

/** Integer cents, at most MAX_AMOUNT_CENTS in size (ledger.md#allocation-and-rounding). */
export const centsSchema = z.int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS)

/** A rate per hour in cents. */
export const rateCentsSchema = z.int().min(0).max(MAX_AMOUNT_CENTS)

/** Text with surrounding spaces removed, then `min`–`max` characters long. */
export function text(min: number, max: number) {
  return z.string().trim().min(min).max(max)
}

export const descriptionSchema = text(1, 200)

/** A person's name (`persons.displayName`, `members.displayName`). */
export const displayNameSchema = text(1, 100)

export const emailSchema = z.string().trim().pipe(z.email().max(254))

/** As typed; `normalizeIdentity()` parses it into E.164. */
export const phoneSchema = text(1, 32).regex(/^\+?[\d\s().-]+$/, 'Not a phone number')

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** An IANA time zone name, e.g. `Australia/Sydney`. */
export const timezoneSchema = z.string().max(64).refine(isTimeZone, 'Unknown time zone')

/** A public holiday region: country, then an optional subdivision, e.g. `AU-NSW`. */
export const regionSchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, 'Expected e.g. AU-NSW')

/** An ISO 4217 currency code, e.g. `AUD`. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Expected e.g. AUD')

/** The body of a route whose body is "none". */
export const emptyBodySchema = z.strictObject({})

/** 1 to MAX_PEOPLE_PER_TRANSACTION entries, naming each person at most once (I-5). */
export function peopleList<T extends z.ZodType>(
  entry: T,
  personIdOf: (entry: z.output<T>) => string,
) {
  return z
    .array(entry)
    .min(1)
    .max(MAX_PEOPLE_PER_TRANSACTION)
    .superRefine((list, ctx) => {
      const personIds = list.map(personIdOf)
      if (new Set(personIds).size !== personIds.length) {
        ctx.addIssue({ code: 'custom', message: 'Each person can appear only once' })
      }
    })
}

/** Adds an issue at `path` unless `from` is on or before `to` (LocalDate text sorts by date). */
export function checkDateOrder(
  from: string | undefined,
  to: string | undefined,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (from !== undefined && to !== undefined && from > to) {
    ctx.addIssue({ code: 'custom', message: 'Must not be before the start date', path: [path] })
  }
}
