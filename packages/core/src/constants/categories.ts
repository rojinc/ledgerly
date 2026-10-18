// data-model.md#categories
export const CATEGORIES = [
  'rent',
  'electricity',
  'gas',
  'water',
  'internet',
  'phone',
  'groceries',
  'household',
  'food',
  'transport',
  'entertainment',
  'health',
  'work',
  'subscriptions',
  'other',
] as const

export type Category = (typeof CATEGORIES)[number]
