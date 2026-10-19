// Keeps any single write under the Appwrite Free plan's 100 operations per
// transaction (scaling.md#appwrite-limits-we-design-around).
export const MAX_ITEMS_PER_TRANSACTION = 30
export const MAX_PEOPLE_PER_TRANSACTION = 15
export const MAX_OPS_PER_DB_TRANSACTION = 90

// ledger.md#allocation-and-rounding: amount × weight stays far below
// Number.MAX_SAFE_INTEGER.
export const MAX_AMOUNT_CENTS = 10_000_000_000
export const MAX_WEIGHT = 10_000

// F-82 (#53): a work-hours limit is the user's own, from 1 hour up to every hour of its period.
export const MIN_HOURS_CAP_MINUTES = 60
export const MAX_HOURS_CAP_MINUTES = { week: 7 * 24 * 60, fortnight: 14 * 24 * 60 } as const

// #50: deleting an account needs a session signed in this recently, so an old, stolen one can't.
export const REAUTH_WINDOW_MINUTES = 10
// …nor while the password is this new: a stolen session could set a first one and sign in again.
export const RECENT_PASSWORD_CHANGE_HOURS = 24

// F-63 (#56): reminders, each counted over a rolling window (identity-and-invites.md#reminders).
export const REMINDER_LIMITS = {
  perSenderPerGroup: { count: 1, days: 3 },
  perRecipient: { count: 3, days: 7 },
  perSender: { count: 20, days: 1 },
} as const
