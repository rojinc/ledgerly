# People, identity and invites

Ledgerly has to work with people who never sign up: employers, friends you lend to, a new housemate who hasn't joined yet. This page explains how one real human stays one **person**, from the first time someone types their phone number until they sign up, and after.

## Building blocks

- **Person** (`persons`): someone who can owe or be owed. `userId` is empty for placeholders.
- **Identity** (`identities`): an email or phone number that belongs to a person. The `key` column is unique, so one email or phone number can only ever belong to one person.
- **Member** (`members`): a person inside a group, with that group's display name for them.

A person's contact details live only in `identities`. Group-specific names live only in `members.displayName`. Nothing else stores them. One exception: an employer group's billing addresses (`GroupSettings.recipients`) are invoice settings the worker typed, not identities, and they are never used to recognise or link a person.

## Normalising identities

Every email or phone number goes through `normalizeIdentity()` in `packages/core` before any lookup:

| Type | Rule | Example |
| --- | --- | --- |
| email | Trim and lowercase. Dots and `+tags` are kept. | ` Sam@Example.com ` → `email:sam@example.com` |
| phone | Parse with `libphonenumber-js`, using the country from the caller's profile `region` as the default (`AU-NSW` → `AU`); reject invalid numbers; format as E.164 | `0412 345 678` (AU) → `phone:+61412345678` |

## First login (bootstrap)

`identity POST /bootstrap` runs on every login and is idempotent:

1. If a profile already exists for this user, return it.
2. Otherwise, in one database transaction:
   - Find or create the user's **person**. If one of the user's verified emails or phones matches an identity row that points at a placeholder, reuse that person (see Claim). Placeholder identity rows are never `verified` themselves, so match on the key, not the flag.
   - Create the **profile** (row ID = user ID) with defaults: timezone from the browser, region and currency from the timezone.
   - Create the **personal group**, its team, and an `admin` membership.
3. Run **Claim** for any verified identities.

## Adding someone to a group

`groups POST /groups/{id}/members` with `{ displayName, email?, phone?, userId? }`:

1. Normalise the email and phone.
2. Look up each identity key.
   - **Found:** use that person.
   - **Not found:** create a placeholder person plus unverified identity rows.
   - If the email and phone point at **two different persons**, use the one with the account, or else the email's. Do **not** merge: unverified data must never join two people.
3. Create the `members` row. If one already exists for that person in this group, return `CONFLICT`.
4. If the person has a user account, add them to the group's team and set status `active`. Otherwise set status `placeholder`.
5. Write an `activity` row (`member.added`).

The response never reveals whether an email or phone number belongs to an existing user. That stops people using the form to find out who uses Ledgerly.

## Claim (linking records to a new account)

Claiming is what lets "Sam" see the $50 you lent them when Sam finally signs up.

**Rule: claim only through verified identities.** Appwrite Auth verifies the email or phone number. A typed-in number proves nothing.

`identity POST /claim` (also run at the end of bootstrap):

1. Using the server SDK, read the user and collect their **verified** email and phone (`emailVerification`, `phoneVerification`).
2. For each verified identity key:
   - **No identity row:** create one pointing at the user's person, with `verified = true`.
   - **Points at the user's own person:** set `verified = true`.
   - **Points at a placeholder person P:**
     - If the user's person is brand new and has no data (bootstrap just made it), **adopt P**: set `P.userId` to the user and use P as their person.
     - Otherwise **merge P into the user's person** (next section).
3. Add the user to the team of every group where their person is a member. Change `placeholder` members to `active`; members who have `left` stay `left`.
4. Return the list of groups that were linked, so the app can say "We found 3 groups you were added to".

## Merging two persons

A merge happens when a verified identity shows that placeholder **P** is the same human as an existing person **U**.

Merges can touch many rows, more than one Appwrite transaction allows (100 operations on Free, 1,000 on Pro). So a merge runs in steps that are each safe to repeat:

1. Set `P.mergedInto = U`. From now on every function resolves P to U when it reads.
2. Repoint these columns from P to U, in batches of at most 90 operations per transaction:
   `members.personId`, `shares.personId`, `transactions.createdBy` / `updatedBy`, `schedules.createdBy`, `activity.actorPersonId`, `invites.invitedBy`, `groups.ownerPersonId`, `identities.personId`.
3. **Same group conflict:** if P and U were both members of one group, keep U's member row and set its `joinedOn` to the earlier of the two. Delete P's member row. Shares need nothing extra, because they point at persons, not member rows. If both had shares in the **same transaction**, combine them into one share (sum given and received) to keep [I-5](ledger.md#invariants).
4. Delete P.

Statement snapshots are **not** rewritten. They are historical documents and keep the old display name.

A merge that stops halfway is finished by the next `/claim` call, or by the nightly cleanup job (M4), which looks for persons with `mergedInto` set.

## Invites

An invite is a convenience: a link that tells someone they've been added and helps them sign up. Claiming works without one, as long as the person verifies the same email or phone.

`identity POST /invites` with `{ groupId, memberId, channel: 'email' | 'sms' }`:

1. The caller must be allowed to add members in that group ([permissions](permissions.md#roles)).
2. **Rate limits:** at most 20 invites per inviter per day, and 3 per identity per 7 days. Otherwise return `RATE_LIMITED`.
3. Create a random 32-byte token (base64url). Store only its SHA-256 hash, with `expiresAt` 14 days ahead.
4. Send `https://<app>/invite#<token>` by email (Resend) or SMS (M3). The token goes in the URL fragment, which browsers never send to servers or in `Referer` headers, so it stays out of logs. The message names the inviter and the group, nothing else.

`identity POST /invites/accept` with `{ token }`:

1. Hash the token and find the invite. If it is missing, expired or already accepted, return `INVITE_INVALID`.
2. The caller must be signed in and have **verified** the invite's identity. If not, return `{ needsVerification: 'email' | 'phone' }`, and the app runs Appwrite's verification flow and then calls accept again.
3. Run Claim and set `acceptedAt`.

## Deleting an account (M4)

1. Remove the user from all teams. Delete their profile, identities and personal group (no one else has data there).
2. Keep the person row so shared history stays correct for everyone else: clear `userId`, set `displayName = "Former member"` and `deletedAt`.
3. Set `members.displayName` to "Former member" and `status = left` in every group.
4. Delete the Appwrite user.

## Privacy rules

- Placeholder contact details are server-only. The UI shows other people only their group display name, never their email or phone.
- Never write raw emails or phone numbers to logs. Log identity keys hashed, or not at all.
- Collect only what a feature needs. No address book uploads.

More in [Security and privacy](security-and-privacy.md).
