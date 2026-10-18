# People, identity and invites

Ledgerly has to work with people who never sign up: employers, friends you lend to, a new housemate who hasn't joined yet. This page explains how one real human stays one **person**, from the first time someone types their phone number until they sign up, and after.

## Building blocks

- **Person** (`persons`): someone who can owe or be owed. `userId` is empty for placeholders.
- **Identity** (`identities`): an email or phone number that belongs to a person. The `key` column is unique, so one email or phone number can only ever belong to one person.
- **Member** (`members`): a person inside a group, with that group's display name for them. Its `status` says whether the person has **joined** the group: `placeholder` (not joined, with or without an account), `active` (joined) or `left` (joined, then moved out).

A person's contact details live only in `identities`. Group-specific names live only in `members.displayName`. Nothing else stores them. One exception: an employer group's billing addresses (`GroupSettings.recipients`) are invoice settings the worker typed, not identities, and they are never used to recognise or link a person.

## Normalising identities

Every email or phone number goes through `normalizeIdentity()` in `packages/core` before any lookup:

| Type | Rule | Example |
| --- | --- | --- |
| email | Trim and lowercase. Dots and `+tags` are kept. | ` Sam@Example.com ` → `email:sam@example.com` |
| phone | Parse with `libphonenumber-js`, using the country from the caller's profile `region` as the default (`AU-NSW` → `AU`); reject invalid numbers; format as E.164 | `0412 345 678` (AU) → `phone:+61412345678` |

## First login (bootstrap)

`identity POST /bootstrap` runs on every login and is idempotent:

1. If a profile already exists for this user, skip to step 3, so an interrupted claim always gets finished.
2. Otherwise, in one database transaction:
   - Find or create the user's **person**. If one of the user's verified emails or phones matches an identity row that points at a placeholder, reuse that person (see Claim). Placeholder identity rows are never `verified` themselves, so match on the key, not the flag. Set the person's `userId` and `claimedAt` (now).
   - Create the **profile** (row ID = user ID) with defaults: timezone from the browser, region and currency from the timezone.
   - Create the **personal group**, its team, and an `admin` membership.
3. Run **Claim** for any verified identities.

## Adding someone to a group

`groups POST /groups/{id}/members` with `{ displayName, email?, phone? }`:

1. Normalise the email and phone.
2. Look up each identity key.
   - **Found:** use that person.
   - **Only one of two keys found:** use the found person and don't store the other key. Unverified data is never attached to an existing person, so a stranger's typo can't land on someone else.
   - **Not found:** create a placeholder person plus unverified identity rows. Person IDs are random, with no timestamp ([data model](data-model.md#persons)), so a new person's ID doesn't show that the email or phone was unknown.
   - If the email and phone point at **two different persons**, use the email's person, whether or not either has an account. Do **not** merge: unverified data must never join two people.
3. Create the `members` row. If one already exists for that person in this group, return `CONFLICT`.
4. Set status `placeholder`, even if the person already has an account ([D-016](decisions.md)). The `groups` function never adds anyone except the group's creator to a team; people join themselves (see [Joining a group](#joining-a-group)).
5. Write an `activity` row (`member.added`).

Because of steps 2 and 4, the member row looks the same whether or not the person has an account, so neither the response nor the members list reveals it. That stops people using the form to find out who uses Ledgerly.

Accepted risks, none of which shows whether someone has an account:

- A person has the same ID in every group, so someone who shares a group with them can add a guessed email to another group and see whether the IDs match. `CONFLICT` on adding someone twice tells the same thing within one group.
- An unknown email takes slightly longer to add than a known one (rows are created). Known emails include placeholders others added, so it shows only that someone has used the email before.

## Claim (linking records to a new account)

Claiming is what lets "Sam" see the $50 you lent them when Sam finally signs up.

**Rule: claim only through verified identities.** Appwrite Auth verifies the email or phone number. A typed-in number proves nothing.

`identity POST /claim` (also run at the end of bootstrap):

1. Using the server SDK, read the user and collect their **verified** email and phone (`emailVerification`, `phoneVerification`).
2. For each verified identity key:
   - **No identity row:** create one pointing at the user's person, with `verified = true`.
   - **Points at the user's own person:** set `verified = true`.
   - **Points at a placeholder person P:**
     - If the user's person is brand new and has no data (bootstrap just made it), **adopt P**: set `P.userId` to the user and `P.claimedAt` to now, and use P as their person.
     - Otherwise **merge P into the user's person** (next section).
3. Join the user to every group where their person is still a `placeholder` member and the member row's `$createdAt` is strictly before the person's `claimedAt`. Those rows were added while the person had no account. Rows added later are left alone; the user joins those themselves ([Joining a group](#joining-a-group)). The rule reads only stored data, so a repeated or interrupted claim finishes the job. Functions never rewrite a member row's `$createdAt` and never delete and recreate a member row.
4. Return the list of groups that were linked, so the app can say "We found 3 groups you were added to".

## Joining a group

A member joins a group only through the person's own action ([D-016](decisions.md)):

- **Claim:** verifying an email or phone joins every group they were added to while they had no account.
- **Accepting an invite** joins that invite's group.
- **Joining from the app:** someone who already had an account when they were added sees the group as pending and joins it themselves. The routes are `groups GET /groups/pending` and `POST /groups/{id}/join` ([Functions API](functions-api.md#groups)); they ship with pair groups in M2.

Joining, done by the `identity` function, in this order so a retry can always finish it:

1. Add the user to the group's team ("already a member" counts as done).
2. In one database transaction: set the status to `active` (or `left` if `leftOn` is already set, so a former housemate can still see and settle up) and write one `member.joined` activity row.

All three ways write the same row, so the group can't tell which one happened.

Until they join, the person doesn't see the group and gets no notifications from it (an invite or an invoice sent to them on purpose is different). Records can still name them, exactly as for any placeholder. Before they join, the group can't tell whether they have an account. After they join, it may be able to (a merge changes their person ID); that's fine, because they chose to join.

## Merging two persons

A merge happens when a verified identity shows that placeholder **P** is the same human as an existing person **U**.

Merges can touch many rows, more than one Appwrite transaction allows (100 operations on Free, 1,000 on Pro). So a merge runs in steps that are each safe to repeat:

1. Set `P.mergedInto = U`. From now on every function resolves P to U when it reads.
2. **P's member rows, one at a time.** P was a placeholder, so all its member rows were added while it had no account, and the merge joins U to each of those groups. For each row:
   1. Add U to the group's team ("already a member" counts as done).
   2. In one database transaction: if U also has a member row in the group, keep U's row, set its `joinedOn` to the earlier of the two and delete P's row; otherwise repoint P's row to U. Then set the kept row's status as in [joining](#joining-a-group) and write `member.joined`.

   A row is finished once it no longer points at P, so a retry carries on with the rest.
3. Repoint the other columns from P to U, in batches of at most 90 operations per transaction: `shares.personId`, `transactions.createdBy` / `updatedBy`, `schedules.createdBy`, `activity.actorPersonId`, `invites.invitedBy`, `groups.ownerPersonId`, `identities.personId`. Shares need nothing extra, because they point at persons, not member rows. If P and U had shares in the **same transaction**, combine them into one share (sum given and received) to keep [I-5](ledger.md#invariants).
4. Delete P.

Statement snapshots are **not** rewritten. They are historical documents and keep the old display name.

A merge that stops halfway is finished by the next `/claim` call, or by the nightly cleanup job (M4), which looks for persons with `mergedInto` set.

## Invites

An invite is a convenience: a link that tells someone they've been added and helps them sign up. Claiming works without one, as long as the person verifies the same email or phone.

`identity POST /invites` with `{ groupId, memberId, email?, phone? }` (exactly one of email or phone):

1. The caller must be allowed to add members in that group ([permissions](permissions.md#roles)).
2. The invite goes only to the address the caller typed. After normalising, it must be an identity of that member's person, otherwise `VALIDATION_FAILED`. Ledgerly never picks an address the caller didn't give, so it never emails an address the inviter doesn't already know.
3. **Rate limits:** at most 20 invites per inviter per day, and 3 per identity per 7 days. Otherwise return `RATE_LIMITED`.
4. Create a random 32-byte token (base64url). Store only its SHA-256 hash, with `expiresAt` 14 days ahead.
5. Send `https://<app>/invite#<token>` by email (Resend) or SMS (M3). The token goes in the URL fragment, which browsers never send to servers or in `Referer` headers, so it stays out of logs. The message names the inviter and the group, nothing else. It is sent the same way, with the same response, whether or not the person has an account.

`identity POST /invites/accept` with `{ token }`:

1. Hash the token and find the invite. If it is missing, expired or already accepted, return `INVITE_INVALID`.
2. The caller must be signed in and have **verified** the invite's identity. If not, return `{ needsVerification: 'email' | 'phone' }`, and the app runs Appwrite's verification flow and then calls accept again.
3. Run Claim. Then, if the caller's own person has a member row in the invite's group that is still `placeholder`, join it. (The invite's `memberId` may have been merged away or removed since.) Set `acceptedAt`.

## Deleting an account (M4)

1. Remove the user from all teams. Delete their profile, identities and personal group (no one else has data there).
2. Keep the person row so shared history stays correct for everyone else: clear `userId`, set `displayName = "Former member"` and `deletedAt`.
3. In the groups they joined: set `members.displayName` to "Former member" and `status = left`. Rows they never joined are left exactly as they are. (Accepted risk: deleting their identities means re-adding that email no longer gives `CONFLICT`.)
4. Delete the Appwrite user.

## Privacy rules

- Placeholder contact details are server-only. The UI shows other people only their group display name, never their email or phone.
- Never write raw emails or phone numbers to logs. Log identity keys hashed, or not at all.
- Collect only what a feature needs. No address book uploads.

More in [Security and privacy](security-and-privacy.md).
