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
  schedules: 'schedules',
  statements: 'statements',
  activity: 'activity',
  invites: 'invites',
} as const

export type TableId = (typeof TABLES)[keyof typeof TABLES]
