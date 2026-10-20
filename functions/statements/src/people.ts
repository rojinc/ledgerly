import type { Identities, Members, Persons, Profiles } from '@ledgerly/core/generated/rows'
import type { EmailType } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'
import { listAll } from './shared'

const EMAIL_KEY = 'email:'

/**
 * Each person's verified email addresses (data-model.md#identities), by person ID. Unverified
 * ones are never used: anyone can type an address in.
 */
export async function verifiedEmails(
  db: Db,
  personIds: readonly string[],
): Promise<Map<string, string[]>> {
  const emails = new Map<string, string[]>()
  if (personIds.length === 0) return emails
  const identities = await listAll<Identities>(db, TABLES.identities, [
    Query.equal('personId', [...personIds]),
    Query.equal('type', 'email'),
    Query.equal('verified', true),
  ])
  for (const identity of identities) {
    const address = identity.key.slice(EMAIL_KEY.length)
    emails.set(identity.personId, [...(emails.get(identity.personId) ?? []), address])
  }
  return emails
}

/**
 * Which of these people turned `type` off on Profile (data-model.md#profiles): a profile is the
 * row of its person's user. Null or `[]` turns nothing off, and a placeholder has no profile.
 */
export async function optedOut(
  db: Db,
  personIds: readonly string[],
  type: EmailType,
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set()
  const persons = await listAll<Persons>(db, TABLES.persons, [Query.equal('$id', [...personIds])])
  const userIds = persons.flatMap((person) => (person.userId ? [person.userId] : []))
  if (userIds.length === 0) return new Set()
  const profiles = await listAll<Profiles>(db, TABLES.profiles, [Query.equal('$id', userIds)])
  const off = new Set(
    profiles
      .filter((profile) => profile.emailOptOuts?.includes(type))
      .map((profile) => profile.$id),
  )
  return new Set(
    persons.filter((person) => person.userId && off.has(person.userId)).map((person) => person.$id),
  )
}

/** The group's admins who have joined: who reviews and finalizes its statements. */
export function joinedAdmins(db: Db, groupId: string): Promise<Members[]> {
  return listAll<Members>(db, TABLES.members, [
    Query.equal('groupId', groupId),
    Query.equal('role', 'admin'),
    Query.equal('status', 'active'),
  ])
}
