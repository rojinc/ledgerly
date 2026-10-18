export const queryKeys = {
  currentUser: ['currentUser'] as const,
  bootstrap: (userId: string) => ['bootstrap', userId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  person: (personId: string) => ['person', personId] as const,
  groups: (userId: string) => ['groups', userId] as const,
  group: (groupId: string) => ['group', groupId] as const,
  myMember: (groupId: string, personId: string) => ['member', groupId, personId] as const,
  balances: (groupId: string) => ['balances', groupId] as const,
}
