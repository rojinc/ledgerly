import type { Identities, IdentitiesType } from '@ledgerly/core/generated/rows'
import { identityKey, normalizePhone } from '@ledgerly/core/identity/normalize'
import { ID, Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import type { Write } from '../appwrite/transaction'
import { randomId } from './random-id'

export type PersonInput = { displayName: string; email?: string; phone?: string }

/** The person to use, and the rows to stage for a new placeholder (none for a known person). */
export type ResolvedPerson = { personId: string; writes: Write[] }

/**
 * identity-and-invites.md#adding-someone-to-a-group, step 2: the person an email or phone
 * belongs to, or a new placeholder with at most one unverified identity row. `region` is the
 * default country for a phone typed without one. Throws a RangeError for an invalid email or
 * phone, which the route turns into VALIDATION_FAILED.
 *
 * It only reads: stage `writes` in the caller's transaction, and pass that transaction's ID to
 * see rows it already staged. If another request creates the same identity key first, the
 * commit fails with 409 (the key is unique), and resolving again finds that person.
 */
export async function resolvePerson(
  db: Db,
  input: PersonInput,
  region: string,
  transactionId?: string,
): Promise<ResolvedPerson> {
  const identities: Array<{ type: IdentitiesType; key: string }> = []
  if (input.email !== undefined) {
    identities.push({ type: 'email', key: identityKey('email', input.email) })
  }
  if (input.phone !== undefined) {
    identities.push({
      type: 'phone',
      key: identityKey('phone', normalizePhone(input.phone, region)),
    })
  }
  // Email first, so it decides when the email and phone belong to two different persons
  // (D-016). A found person is used as it is: never merged, and an unknown key is never
  // attached to it, so a stranger's typo can't land on someone else.
  for (const { key } of identities) {
    const { rows } = await db.listRows<Identities>({
      databaseId: DATABASE_ID,
      tableId: TABLES.identities,
      queries: [Query.equal('key', key), Query.limit(1)],
      transactionId,
      total: false,
    })
    if (rows[0]) return { personId: rows[0].personId, writes: [] }
  }
  // A placeholder has no permissions (server only) and a random ID (data-model.md#persons). It
  // keeps one key, the email if there is one: whoever verifies a placeholder's key claims it,
  // so a second key would let the person who typed one claim what is added later by the other.
  const personId = randomId()
  const writes: Write[] = [
    {
      action: 'create',
      tableId: TABLES.persons,
      rowId: personId,
      data: { displayName: input.displayName },
      permissions: [],
    },
    ...identities.slice(0, 1).map(
      ({ type, key }): Write => ({
        action: 'create',
        tableId: TABLES.identities,
        rowId: ID.unique(),
        data: { key, type, personId, verified: false },
        permissions: [],
      }),
    ),
  ]
  return { personId, writes }
}
