// Keeps any single write under the Appwrite Free plan's 100 operations per
// transaction (scaling.md#appwrite-limits-we-design-around).
export const MAX_ITEMS_PER_TRANSACTION = 30
export const MAX_PEOPLE_PER_TRANSACTION = 15
export const MAX_OPS_PER_DB_TRANSACTION = 90

// ledger.md#allocation-and-rounding: amount × weight stays far below
// Number.MAX_SAFE_INTEGER.
export const MAX_AMOUNT_CENTS = 10_000_000_000
export const MAX_WEIGHT = 10_000
