// data-model.md: the database and its tables. tables.test.ts checks these against appwrite/tables.json.
export const DATABASE_ID = 'main'

export const TABLES = {
  persons: 'persons',
  identities: 'identities',
  profiles: 'profiles',
  groups: 'groups',
  members: 'members',
  transactions: 'transactions',
  shares: 'shares',
  items: 'items',
  balances: 'balances',
  receiptFiles: 'receiptFiles',
  checkpoints: 'checkpoints',
  schedules: 'schedules',
  statements: 'statements',
  activity: 'activity',
  invites: 'invites',
  reminders: 'reminders',
} as const

export type TableId = (typeof TABLES)[keyof typeof TABLES]
