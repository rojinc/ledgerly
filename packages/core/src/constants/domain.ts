// The enums from data-model.md. Column values must use exactly these words.

export const GROUP_TYPES = ['personal', 'house', 'employer', 'pair'] as const
export type GroupType = (typeof GROUP_TYPES)[number]

export const TRANSACTION_KINDS = [
  'shift',
  'expense',
  'bill',
  'payment',
  'loan',
  'income',
  'adjustment',
] as const
export type TransactionKind = (typeof TRANSACTION_KINDS)[number]

export const TRANSACTION_STATUSES = ['scheduled', 'running', 'due', 'posted', 'void'] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

export const ROLES = ['admin', 'member', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const MEMBER_STATUSES = ['placeholder', 'active', 'left'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]

export const STATEMENT_STATUSES = ['draft', 'finalizing', 'final', 'void'] as const
export type StatementStatus = (typeof STATEMENT_STATUSES)[number]
