# People, identity and invites

Ledgerly has to work with people who never sign up: employers, friends you lend to, a new housemate who hasn't joined yet. This page explains how one real human stays one **person**, from the first time someone types their phone number until they sign up, and after.

## Building blocks

- **Person** (`persons`): someone who can owe or be owed. `userId` is empty for placeholders.
- **Identity** (`identities`): an email or phone number that belongs to a person. The `key` column is unique, so one email or phone number can only ever belong to one person.
- **Member** (`members`): a person inside a group, with that group's display name for them. Its `status` says whether the person has **joined** the group: `placeholder` (not joined, with or without an account), `active` (joined) or `left` (joined, then moved out).

A person's contact details live only in `identities`. Group-specific names live only in `members.displayName`. Nothing else stores them. One exception: an employer group's billing addresses (`GroupSettings.recipients`) are invoice settings the worker typed, not identities, and they are never used to recognise or link a person.

## Normalising identities

Every email or phone number goes through `normalizeEmail()` or `normalizePhone()` (`packages/core/src/identity/normalize.ts`) before any lookup, and `identityKey()` builds the key from the result. Invalid input throws a `RangeError` whose message never repeats the input, and the calling route turns it into `VALIDATION_FAILED`:

| Type | Rule | Example |
| --- | --- | --- |
| email | Trim and lowercase. Dots and `+tags` are kept. | ` Sam@Example.com ` → `email:sam@example.com` |
| phone | Parse with `libphonenumber-js`, using the country from the group's `region` as the default (the group the person is being added to; `AU-NSW` → `AU`); reject numbers that `libphonenumber-js` (min metadata) calls invalid, in national or E.164 form, and numbers with an extension; format as E.164 | `0412 345 678` (AU) → `phone:+61412345678` |

## First login (bootstrap)

`identity POST /bootstrap` runs on every login and is idempotent:

1. If a profile already exists for this user, skip to step 3, so an interrupted claim always gets finished.
2. Otherwise, create the personal group's team and add the user to it ("already exists" counts as done). Like every team membership, it has no team role, never `owner`, so the user can't manage the team from the client. Then, in one database transaction:
   - Find or create the user's **person**. If one of the user's verified emails or phones matches an identity row that points at a placeholder, reuse that person (see Claim). Placeholder identity rows are never `verified` themselves, so match on the key, not the flag. Set the person's `userId` and `claimedAt` (now).
   - Create the **profile** (row ID = user ID) with defaults: timezone from the browser, region and currency from the timezone. An Australian time zone gives its state (`Australia/Perth` → `AU-WA`); any other gives `AU-NSW`. The currency is `AUD`. The user can change all of them in their profile.
   - Create the **personal group** and the user's `admin` member row.

   The team comes first so that no saved row names a team that doesn't exist. An interrupted bootstrap can leave a team with no group row, which grants nothing.
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
- An invite to an address that isn't the member's gets `VALIDATION_FAILED` ([invites](#invites), step 2), so an inviter can test guesses at a placeholder's email or phone, within the invite limits. It's the same kind of leak as `CONFLICT` above.

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
- **Joining from the app:** someone who already had an account when they were added sees the group as pending and joins it themselves. The routes are `identity GET /groups/pending` and `identity POST /groups/{id}/join` ([Functions API](functions-api.md#identity)); they ship with pair groups in M2 ([#34](https://github.com/rojinc/ledgerly/issues/34)).

Joining, done by the `identity` function, in this order so a retry can always finish it:

1. Add the user to the group's team ("already a member" counts as done).
2. In one database transaction: set the status to `active` (or `left` if `leftOn` is already set, so a former housemate can still see and settle up) and write one `member.joined` activity row. If this step fails, or the member row is gone by now (an admin removed it meanwhile), remove the team membership from step 1 again, so no one keeps access without having joined. Only a row a parallel join has just joined keeps it.

All three ways write the same row, so the group can't tell which one happened.

Until they join, the person doesn't see the group's data (only its name, type and whether it's archived in their pending list, plus, for a pair group, the other member's display name, so they can tell who added them) and gets no notifications from it (an invite or an invoice sent to them on purpose is different). Records can still name them, exactly as for any placeholder. Before they join, the group can't tell whether they have an account. After they join, it may be able to (a merge changes their person ID); that's fine, because they chose to join.

## Merging two persons

A merge happens when a verified identity shows that placeholder **P** is the same human as an existing person **U**. P is kept for good, with `mergedInto = U`, so anything that still names P (an old statement's closings, a group U left on their own) can be resolved.

Merges can touch many rows, more than one Appwrite transaction allows (100 operations on Free, 1,000 on Pro). So a merge runs in steps that are each safe to repeat:

1. **Mark P.** Stage `P.mergedInto = U`, then read P's stored row again. If another adoption or merge got there first, leave P alone. From now on every function resolves P to U when it reads: `resolvePerson()` follows `mergedInto` to the end of the chain, so an email added for P mid-merge is added for U.
2. **P's member rows, one at a time.** P was a placeholder, so all its member rows were added while it had no account, and the merge joins U to each of those groups, except where U left on their own.
   - **A group U left on their own** (U's row there has U's own `member.left` as the newest of their `member.left` and `member.joined` rows): leaving on your own is final for that row ([leaving a group](permissions.md#leaving-a-group)). So U isn't added to the team, U's row isn't touched, no share moves to U, and P keeps its row and its shares there, as a placeholder with no identities. These are the merge's **kept groups**. Coming back after leaving stays unsupported, and a new invite can't help either: U's row blocks a second one (`uniq_group_person`).
   - **Every other group:**
     1. Add U to the group's team ("already a member" counts as done).
     2. In one database transaction: if U also has a member row in the group, keep U's row, set its `joinedOn` to the earlier of the two and delete P's row; otherwise repoint P's row to U. Then set the kept row's status as in [joining](#joining-a-group) and write `member.joined` by U. Both rows are staged before they're checked, so a ledger write that guards one of them ([concurrency](ledger.md#concurrency)) runs again, and so does this step if one of them changed. If the transaction fails, take the team membership back, unless U has a joined row there.

   A row is finished once it no longer points at P, so a retry carries on with the rest.
3. **P's shares, inputs and identities, in batches** of at most 90 operations per database transaction, guard writes included, skipping kept groups:
   - **Guards first:** a batch that changes a group's shares or inputs stages a guard write (a fresh `rev`) on that group's row, then checks that no statement in the group is `finalizing`. If one is, that group's work is left for the next `/claim`. Every writer of shares writes the group `rev` ([concurrency](ledger.md#concurrency)), which is how `GET /balances` knows a read was complete.
   - **Shares:** repoint `shares.personId` from P to U. If P and U have shares in the **same transaction**, combine them into one share (sum given and received) to keep [I-5](ledger.md#invariants). Both are staged, then read again, so two merges can't add P's share twice. This includes shares of locked transactions: the merge is the one writer allowed to change those, and only this way ([I-7](ledger.md#invariants)). No transaction's total changes, so every group still sums to 0 after each batch (I-1).
   - **Inputs:** P becomes U inside the stored inputs that name people: `transactions.inputJson` and `items.splitJson` of every transaction that **isn't locked or void** (unposted ones, schedule occurrences included, and posted ones, since an edit reads them again), and `schedules.templateJson`. A locked transaction's stored input and items keep naming P: nothing can edit it, I-7 allows only the share repoint, and P is kept, so the name still resolves. A schedule's rewrite is staged with the scheduler's schedule guard (a write to the schedule row, then a check of the stored row), so an expansion in flight can't race it. Where U is already listed, the entries are added up: payer amounts, `exact` amounts, `percent` basis points and `weights` add; an `equal` split becomes `weights` (U 2, everyone else 1); a `days` split lists U once, since presence comes from U's kept member row. A `payment` or `loan` that isn't locked and whose two sides would both become U is voided instead, posted or not (its shares net to 0 for U either way). Each rewritten row is staged, then read again, so a row that was posted, edited or voided meanwhile makes the batch run again. One pure helper in `packages/core` does this rewrite.
   - **Identities:** repoint `identities.personId` from P to U.
   - Columns that only ever hold a person with an account (`createdBy`, `updatedBy`, `actorPersonId`, `invitedBy`, `ownerPersonId`) can't name a placeholder, so they're left alone.
4. **Finished.** P is never deleted. A merge is finished when nothing outside the kept groups still names P: no identity, member row, share, input or item split of a transaction that isn't locked, or schedule template. A batch put off for a group (a `finalizing` statement, or the time budget) therefore keeps the merge unfinished, whatever order the batches ran in. Until then, `/claim` (for persons whose `mergedInto` is the caller's person, `idx_mergedInto`) and the nightly cleanup job (M4) carry on with it; after that, they leave P alone. `/claim` stops starting batches after a time budget well inside the function's timeout.

A merge cut off partway leaves some of P's shares on P and some on U. Each batch keeps every group at 0, but until the next `/claim` finishes it, balances show P and U as two people. A statement drafted or finalized between batches resolves P to U wherever P has no member row ([statements](statements.md#core-rules), rule 2), so it still adds up.

Statement snapshots are **not** rewritten. They are historical documents and keep the old display name; openings follow `mergedInto` when they're read ([statements](statements.md#core-rules)). The exception for locked shares is in [I-7](ledger.md#invariants) and [D-010](decisions.md#d-010-closed-periods-never-change).

## Invites

An invite is a convenience: a link that tells someone they've been added and helps them sign up. Claiming works without one, as long as the person verifies the same email or phone.

`identity POST /invites` with `{ groupId, memberId, email?, phone? }` (exactly one of email or phone):

1. The caller must be allowed to add members in that group ([permissions](permissions.md#roles)) and must have a verified email ([F-02](../product/features.md#accounts-and-profile)); otherwise `FORBIDDEN`.
2. `memberId` must be in that group (otherwise `NOT_FOUND`) and still a `placeholder` (otherwise `VALIDATION_FAILED`). The invite goes only to the address the caller typed. After normalising, it must be an identity of that member's person, otherwise `VALIDATION_FAILED`. Ledgerly never picks an address the caller didn't give, so it never emails an address the inviter doesn't already know.
3. **Rate limits:** at most 20 invites per inviter in the last 24 hours, and 3 per identity in the last 7 days. Otherwise return `RATE_LIMITED`, before anything is committed. So that a burst of parallel requests can't pass the count together, first stage a guard write (a fresh `rev`) on the inviter's and the target's `persons` rows, then count.
4. Create a random 32-byte token (base64url). Store only its SHA-256 hash, with `expiresAt` 14 days ahead. Commit the invite row before sending, so a failed send still counts toward the limits (it returns `INTERNAL`).
5. Send `https://<app>/invite#<token>` by email (Resend) or SMS (M3). The token goes in the URL fragment, which browsers never send to servers or in `Referer` headers, so it stays out of logs. The message names the inviter and the group, nothing else. It is sent the same way, with the same response, whether or not the person has an account.

`identity POST /invites/accept` with `{ token }`:

1. Hash the token and find the invite. If it is missing, expired or already accepted, return `INVITE_INVALID`.
2. The caller must be signed in and have **verified** the invite's identity. If not, return `{ needsVerification: 'email' | 'phone' }`, and the app runs Appwrite's verification flow and then calls accept again.
3. Run Claim. Then, if the caller's own person has a member row in the invite's group that is still `placeholder`, join it. (The invite's `memberId` may have been merged away or removed since.) A row the caller's person left on their own is never touched. Set `acceptedAt`.

## Deleting an account (M4)

`account POST /delete` ([functions API](functions-api.md#account)), from the delete screen ([#50](https://github.com/rojinc/ledgerly/issues/50)). Deletion has its own function, `account`, so `identity` (which runs bootstrap for every new user) never holds `users.write` or file access. **Deleting means anonymising.** Shares, statements and balances point at the person ([I-3](ledger.md#invariants)), so the `persons` row stays: `deletedAt` set, `userId` cleared, `displayName` "Former member", and no permissions. Their identities, profile (business details included), the invites they sent and the Appwrite user are deleted. There is no undo or grace period in v1: typing DELETE is the confirmation.

### Each group they joined

For every group where they have an `active` or `left` member row, its team decides:

- **Purge, if nobody else is in the team.** This is always true of the personal group. It deletes the team and sets `archivedAt` first, so jobs and writes stop. Then the group's files go, then its rows, in batches of at most 90 writes (each transaction with its shares and items, and its receipts taken off ([receiptFiles](data-model.md#receiptfiles)), member rows after all shares), then any placeholder left with no member row anywhere (its person and identities). A file is deleted only when its permissions are exactly `read("team:<the purged group>")`, so a file shared with another group's transaction stays. A placeholder is deleted only after a staged write, and only if, re-checked after it, `isPlaceholder()` still says so (a merged person is kept) and it still has no member row.
- **Keep, otherwise.** In one transaction, with a fresh group `rev`: their member row becomes "Former member", `left` and `viewer`, with `leftOn` set as leaving sets it (today in the group's time zone, or `joinedOn` if that's later) if it's empty, so `days` bills stop counting them; and a `member.left` activity row by them, with `subjectPersonId` = their person and no name, so the row counts as leaving on their own ([leaving](permissions.md#leaving-a-group)). Then, in this order: **the schedules** in the group that they created, or whose template names them, end on the earlier of their stored end and today, as `POST /schedules/{id}/end` does (occurrences after it that can still change are removed, so no new occurrence names a deleted person; Part 3 moves that end logic into `packages/server`); **then the archive**, for a kept `employer` or `pair` group where they were the only joined admin, or a kept house that can't have another admin (below), since ending a schedule in an archived group is refused; **then leaving the team, last**, so a crash before it leaves the group to be finished, never with its schedules still running.

**A rerun never decides again.** What a group's state says decides how a rerun carries on, never the team as it is by then:

- **The group's team is gone:** a purge was started, so it carries on. Their own member row, deleted last, ends it.
- **Their member row is `left`, with their own `member.left` dated on or after `deletedAt`** (`leftOnTheirOwn()` with `deletedAt` as the earliest date, rather than the member row's `$createdAt`)**:** the keep's transaction is done. If they're still in the team, the schedule, archive and team steps are retried; otherwise the group is done and skipped, even if everyone else has since left the team.
- Anything else is decided from the team, as above.

**Changes after the checks.** Step 1's checks can be overtaken before a group's turn comes, and a deletion can't be refused after step 2. A kept house left with no other joined admin (say a placeholder joined a house they were alone in, or the other admin left meanwhile) is archived, like an employer or pair group. A group with a statement `finalizing` isn't archived or purged until the finalize ends: the group is left for the next run.

Groups where they're a `placeholder` (never joined) are left exactly as they are: changing them would show the other members they had an account ([D-016](decisions.md#d-016-being-added-to-a-group-doesnt-make-you-a-member-you-join)).

### Refusals

Checked in this order, and each changes nothing:

1. **The body isn't `{ confirm: 'DELETE' }`:** `VALIDATION_FAILED`.
2. **The session is old.** The route reads the session ID from the caller's verified JWT and loads that session (`users.listSessions`). If it was created more than 10 minutes ago (`REAUTH_WINDOW_MINUTES`), it answers `FORBIDDEN` with `details: { reason: 'reauth' }`. The app asks them to sign in again (password or email code) and retries. So a stolen session that's been open a while can't delete the account. The check fails closed: a JWT with no session ID, or a session that `users.listSessions` doesn't return, gets the same answer.
3. **The password changed recently.** If the user's `passwordUpdate` is less than 24 hours old (`RECENT_PASSWORD_CHANGE_HOURS`), the answer is `FORBIDDEN` with `details: { reason: 'recent_password_change' }`. A stolen session on an account without a password could otherwise set a first one (#203 allows that without an old password), sign in fresh and pass step 2. Appwrite also sets `passwordUpdate` when an account without a password changes its email or phone, so those are caught too. Accepted: a new account that set a password today can't delete it until tomorrow.
4. **A timer is running** in a group that isn't archived: `CONFLICT`. They stop or void it first. A timer left in an archived group can't be stopped, and doesn't block deletion ([timer shifts](scheduling.md#timer-shifts)).
5. **They're the only joined admin of a house that isn't archived and has another `active` member** who could be made admin: `VALIDATION_FAILED` with `details: { groupIds }` (an exception to `details` holding schema issues). They make someone else admin first: the rule leaving uses ([leaving](permissions.md#leaving-a-group)). A kept house where nobody else could be admin (it's archived, or everyone else in its team has moved out) is archived instead, as an employer or pair group is. A house with nobody else in its team is purged, as above.

Non-zero balances don't block it; the delete screen warns about them.

### Order

1. The refusal checks.
2. Set `persons.deletedAt` and `displayName` "Former member", with a fresh `rev` (a [guard write](ledger.md#concurrency)). **This is the point of no return:** from here every step runs to the end, and none is undone. A call after this skips the checks (apart from the body) and carries on.
3. Label the Appwrite user `deleted` (`users.updateLabels`), block them and delete their sessions, so an old JWT fails `account.get()` (`UNAUTHENTICATED`). A 404 counts as done.
4. The groups, one at a time, as above.
5. Only once **every** group is done: delete their identities, the invites they sent and their profile.
6. Clear `persons.userId` and the row's `read("user:<userId>")` permission.
7. Delete the Appwrite user (a 404 counts as done).

Step 6 comes before step 7 because Appwrite user IDs are chosen by the client at sign-up: once the user is deleted, someone who knows the ID could sign up with it, and must not find a person to bootstrap into. For the same reason, **a person with `deletedAt` is never resolved from a `userId`** (bootstrap, claim and join skip it).

Every step can be repeated: a crash after any of them, then a rerun, leaves the same rows. The route works for up to 20 seconds and returns `{ deletedAt, finished }`. The hourly job (`account POST /`, scheduled only) finishes any person with `deletedAt` set and `userId` still set (`persons.idx_deletedAt`), and deletes any Appwrite user labelled `deleted` whose person no longer names it. It skips deletions started in the last minute, which the route may still be running.

### What is kept, and why

- **Final statements, their snapshots and PDFs in kept groups,** as issued, ABN and bank details included: other members already hold these documents ([D-010](decisions.md#d-010-closed-periods-never-change)). Merges don't rewrite them either.
- **Receipts on kept transactions, and text other people typed** (descriptions, notes, void reasons).
- **Groups they left on their own:** their member row is renamed "Former member"; their shares and history stay, like any kept group's. They aren't in `my-records.csv`, since the user can no longer read those groups: export gap, accepted for v1.
- **Receipts they uploaded but never attached** keep their own permissions until the scheduler's clean-up deletes them ([#163](https://github.com/rojinc/ledgerly/issues/163)).
- **Activity rows already written,** with the text they were written with. New member and group rows name no one: their summaries and `changesJson` hold no display name, and `subjectPersonId` points at the member's person, so the app shows the current name ("Former member" after deletion) without rewriting rows ([activity](data-model.md#activity)). Activity is deleted only with a purged group.

A purged group's invoices go with it, so the delete screen tells users to export first ([data export](security-and-privacy.md#data-export)). Appwrite's backups keep deleted data for their own retention period ([retention](security-and-privacy.md#retention)).

### After deletion

- **Signing up again** with the same email makes a new person. The old one is never linked back: its identities are gone, `isPlaceholder()` skips persons with `deletedAt`, and no `userId` resolves to it. Claim and join skip a group whose team is gone, and a merge into a deleted person is never continued.
- **No new record names a deleted person where they had joined.** In a group where their member row isn't `placeholder` (in practice the kept groups), the ledger refuses an input whose people (`everyPersonId()`: payers, the split, items) include them when the stored input didn't already, and the scheduler refuses such a template (`VALIDATION_FAILED`, [functions API](functions-api.md#ledger)). Payments and adjustments that name them stay allowed, so balances with a former member can still be settled. Where they never joined, nothing changes, so the refusal can't show the deletion (D-016). Records that already name them can still be corrected, posted and voided.
- Accepted risk: with their identities deleted, adding that email to a group again makes a new placeholder instead of answering `CONFLICT`, and an invite to it goes to whoever holds the address now. An invite to their *old* placeholder row (in a group they never joined) with that email gets `VALIDATION_FAILED`, since the row's person is deleted.

## Privacy rules

- Placeholder contact details are server-only. The UI shows other people only their group display name, never their email or phone.
- Never write raw emails or phone numbers to logs. Log identity keys hashed, or not at all.
- Collect only what a feature needs. No address book uploads.

More in [Security and privacy](security-and-privacy.md).
