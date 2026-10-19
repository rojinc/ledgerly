export const queryKeys = {
  currentUser: ['currentUser'] as const,
  bootstrap: (userId: string) => ['bootstrap', userId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  person: (personId: string) => ['person', personId] as const,
  groups: (userId: string) => ['groups', userId] as const,
  group: (groupId: string) => ['group', groupId] as const,
  myMember: (groupId: string, personId: string) => ['member', groupId, personId] as const,
  balances: (groupId: string) => ['balances', groupId] as const,
  calendar: (userId: string, start: string, end: string, groupIds: readonly string[]) =>
    ['calendar', userId, start, end, ...groupIds] as const,
  transaction: (id: string) => ['transaction', id] as const,
  transactionShares: (id: string) => ['transaction', id, 'shares'] as const,
  members: (groupId: string) => ['members', groupId] as const,
  history: (groupId: string, filters: Readonly<Record<string, string | undefined>>) =>
    ['history', groupId, filters] as const,
}
