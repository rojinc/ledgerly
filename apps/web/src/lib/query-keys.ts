export const queryKeys = {
  currentUser: ['currentUser'] as const,
  bootstrap: (userId: string) => ['bootstrap', userId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  person: (personId: string) => ['person', personId] as const,
}
