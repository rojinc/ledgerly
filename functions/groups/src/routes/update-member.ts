import type { Services } from '../services'

// TODO(#21): stub, replaced by the route's implementation.
export async function updateMember(
  _services: Services,
  userId: string,
  groupId: string,
  memberId: string,
  body: unknown,
): Promise<unknown> {
  throw new Error('Not implemented')
}
