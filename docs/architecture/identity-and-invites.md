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
   - Find or create the user's **person**. If one of the user's verified emails or phones matches an identity row that points at a placeholder, reuse that person (see Claim). Placeholder identity rows are never `verified` themselves, so match on the key, not the flag. Set the person's `userId` and `claimedAt` (now), and delete the placeholder's identities whose key the user hasn't verified ([only verified keys move](#only-verified-keys-move)): the verified keys come from bootstrap's own read of the user, through the same `verifiedIdentities()` as Claim step 1.
   - Create the **profile** (row ID = user ID) with defaults: timezone from the browser, region and currency from the timezone. An Australian time zone gives its state (`Australia/Perth` → `AU-WA`); any other gives `AU-NSW`. The currency is `AUD`. The user can change all of them in their profile.
   - Create the **personal group** and the user's `admin` member row.

   The team comes first so that no saved row names a team that doesn't exist. An interrupted bootstrap can leave a team with no group row, which grants nothing.
3. Run **Claim** for any verified identities.

## Adding someone to a group

`groups POST /groups/{id}/members` with `{ displayName, email?, phone? }` (and an employer or pair group's counterpart at `POST /groups`, the same way):

1. Normalise the email and phone.
2. Look up each identity key.
   - **Found:** use that person. Stage a guard write on that person's `rev`, then read the keys again: a key that moved to another person, or was removed, meanwhile (an adoption or a merge's step 1 writes the person) answers `CONFLICT`, and the add is tried again.
   - **Only one of two keys found:** use the found person and don't store the other key. Unverified data is never attached to an existing person, so a stranger's typo can't land on someone else.
   - **Not found:** create a placeholder person plus **one** unverified identity row: the email if one was given, otherwise the phone (none for a name alone). The other key is still validated but not stored, so a placeholder can only ever be claimed through one key ([only verified keys move](#only-verified-keys-move)). The add form says which key is used. Person IDs are random, with no timestamp ([data model](data-model.md#persons)), so a new person's ID doesn't show that the email or phone was unknown.
   - If the email and phone point at **two different persons**, use the email's person, whether or not either has an account. Do **not** merge: unverified data must never join two people.
3. Create the `members` row. If one already exists for that person in this group, return `CONFLICT`.
4. Set status `placeholder`, even if the person already has an account ([D-016](decisions.md)). The `groups` function never adds anyone except the group's creator to a team; people join themselves (see [Joining a group](#joining-a-group)).
5. Write an `activity` row (`member.added`).

Because of steps 2 and 4, the member row looks the same whether or not the person has an account, so neither the response nor the members list reveals it. That stops people using the form to find out who uses Ledgerly.

Accepted risks, none of which shows whether someone has an account:

- A person has the same ID in every group, so someone who shares a group with them can add a guessed email to another group and see whether the IDs match. `CONFLICT` on adding someone twice tells the same thing within one group.
- Known and unknown keys take different times to add: an unknown one creates rows, and a known one costs a guard write and a second lookup. Known keys include placeholders others added, and the guard runs the same way for placeholders and registered people, so it shows only that someone has used the key before.
- An invite to an address that isn't the member's gets `VALIDATION_FAILED` ([invites](#invites), step 2), so an inviter can test guesses at a placeholder's email or phone, within the invite limits. It's the same kind of leak as `CONFLICT` above.

## Claim (linking records to a new account)

Claiming is what lets "Sam" see the $50 you lent them when Sam finally signs up.

**Rule: claim only through verified identities.** Appwrite Auth verifies the email or phone number. A typed-in number proves nothing.

`identity POST /claim` (also run at the end of bootstrap):

1. Using the server SDK, read the user and collect their **verified** email and phone (`emailVerification`, `phoneVerification`).
2. For each verified identity key:
   - **No identity row:** create one pointing at the user's person, with `verified = true`.
   - **Points at the user's own person:** set `verified = true`.
   - **Points at a person being merged into the user's person** (that person's `mergedInto` is the user's person, mid-merge): skip it; the merge moves it to them last.
   - **Points at a placeholder person P:**
     - If the user's person is brand new and has no data (bootstrap just made it), **adopt P**: in one database transaction, set `P.userId` to the user and `P.claimedAt` to now, and delete P's identities whose key the user hasn't verified ([below](#only-verified-keys-move)); then read P's stored row again and check it's still a placeholder. If another adoption or merge got there first, roll back and leave P alone, as merge step 1 does. Use P as their person.
     - Otherwise **merge P into the user's person** (next section).
3. Join the user to every group where their person is still a `placeholder` member and the member row's `$createdAt` is strictly before the person's `claimedAt`. Those rows were added while the person had no account. Rows added later are left alone; the user joins those themselves ([Joining a group](#joining-a-group)). The rule reads only stored data, so a repeated or interrupted claim finishes the job. Functions never rewrite a member row's `$createdAt` and never delete and recreate a member row.
4. Return the list of groups that were linked, so the app can say "We found 3 groups you were added to".

### Only verified keys move

A placeholder's identities were typed by whoever added it, and nobody has verified them. When a user claims placeholder P, by adopting it or merging it, **only the keys that user has verified move to their person**. P's other identities are deleted, in the same transaction that marks P: the adoption's (which sets `userId`) or the merge's step 1 (which sets `mergedInto`). So `resolvePerson()` can never follow one of them to the user, even mid-merge.

- **A verified key** is the key of an email or phone that Appwrite Auth shows as verified on the user's own account (`emailVerification`, `phoneVerification`), as read in Claim step 1. The key the claim came through is always one of them.
- **One typed key per placeholder.** Adding someone stores one key for a new placeholder ([adding someone](#adding-someone-to-a-group)), so the person who verifies that key is the only one who can claim it. With two keys, whoever verified *either* could take the placeholder, and with it the rows other groups had already added under the other key.
- **Why both rules:** otherwise someone could add `{ email: victim@x, phone: <their own phone> }` to their own group, verify the phone, and claim: `email:victim@x` would then point at them, every group that later adds the victim would add them instead, and the victim could never claim the address. Or they could add `{ phone: <the victim's>, email: <one of their own> }`, wait for other groups to add the victim by phone, then sign up with the email and take those groups. With one key per placeholder and only verified keys moving, neither works: a later add of the victim's key finds no identity and makes a new placeholder.
- **The trade-off:** a typed key the user hasn't verified is dropped, even when it really is theirs. A later add by that key makes a new placeholder, which is merged into them once they verify it ([#176](https://github.com/rojinc/ledgerly/issues/176) for phones).
- **Logs:** a claim's deleted identities are logged as IDs and counts, never keys.
- **Accepted risk, for later:** sign-in providers (Google, when OAuth comes) must be enabled only where they confirm the email is verified, or a provider account could claim someone's email.

So every identity of a person with an account holds a key they verified.

## Joining a group

A member joins a group only through the person's own action ([D-016](decisions.md)):

- **Claim:** verifying an email or phone joins every group they were added to while they had no account.
- **Accepting an invite** joins that invite's group.
- **Joining from the app:** someone who already had an account when they were added sees the group as pending and joins it themselves. The routes are `identity GET /groups/pending` and `identity POST /groups/{id}/join` ([Functions API](functions-api.md#identity)); they ship with pair groups in M2 ([#34](https://github.com/rojinc/ledgerly/issues/34)).

Joining, done by the `identity` function, in this order so a retry can always finish it:

1. Add the user to the group's team ("already a member" counts as done). A team that's gone means an account deletion is [purging](#each-group-they-joined) the group, its member rows last: the row is skipped, not joined, and the claim goes on to the others (a join from the app answers `NOT_A_MEMBER`). If the team goes just after step 2 commits, the row stays joined and the purge deletes it with the others: the claim leaves the group out, and a join from the app answers with the row. An archived group with its team joins as before.
2. In one database transaction: set the status to `active` (or `left` if `leftOn` is already set, so a former housemate can still see and settle up) and write one `member.joined` activity row. If this step fails, or the member row is gone by now (an admin removed it meanwhile), remove the team membership from step 1 again, so no one keeps access without having joined. Only a row a parallel join has just joined keeps it.

All three ways write the same row, so the group can't tell which one happened.

Until they join, the person doesn't see the group's data (only its name, type and whether it's archived in their pending list, plus, for a pair group, the other member's display name, so they can tell who added them) and gets no notifications from it (an invite or an invoice sent to them on purpose is different). Records can still name them, exactly as for any placeholder. Before they join, the group can't tell whether they have an account. After they join, it may be able to (a merge changes their person ID); that's fine, because they chose to join.

## Merging two persons

A merge happens when a verified identity shows that placeholder **P** is the same human as an existing person **U**. P is kept for good, with `mergedInto = U`, so anything that still names P (an old statement's closings, a group U left on their own) can be resolved.

Merges can touch many rows, more than one Appwrite transaction allows (100 operations on Free, 1,000 on Pro). So a merge runs in steps that are each safe to repeat:

1. **Mark P.** In one database transaction, stage `P.mergedInto = U` and the deletion of P's identities whose key U hasn't verified ([only verified keys move](#only-verified-keys-move)), then read P's stored row again. If another adoption or merge got there first, roll back and leave P alone. After staging, the same transaction lists P's member rows (`idx_person_status`, every status) and records their groups as **P's groups**, `P.mergeGroupIds`. The list is final. It also reads U's member rows in those groups (by person, with the groups in chunks under the query filter's value cap) and records, in `P.mergeMembersJson`, P's `joinedOn` and `leftOn` in each group, and U's where U has a row there. Step 3 plans a posted row's items with these dates, as the members were before the merge, so an item split by `days` keeps every part (a lead decision, #242 B2; see **Inputs** in step 3). An add that found P stages a guard write on P's row (`persons.rev`, L2 in #252) and then resolves its keys again. If this step commits after that guard, the add fails its commit. If it committed first, the add's second resolve follows `mergedInto` (as every read does from now on), finds U rather than P, and answers `CONFLICT`. In both orders the add is tried again and lands on U. And if the add commits first, step 1's listing sees its row (or step 1's commit fails, since the add guarded P's row: that claim leaves P as it is, and the user's next claim marks P and sees the row). So no member row for P appears outside P's groups. Shares, inputs and templates are looked for only in those groups, in this claim and every later one that carries the merge on, never in all of U's, so a merge costs what P had, not what U has. From now on every function resolves P to U when it reads: `resolvePerson()` follows `mergedInto` to the end of the chain, so an email added for P mid-merge is added for U.
2. **P's member rows, one at a time.** P was a placeholder, so all its member rows were added while it had no account, and the merge joins U to each of those groups, except where U left on their own. Steps 2 and 3 go one of P's groups at a time: P's member row there, then the group's templates, inputs and shares, before the next group. So a merge cut off by the time budget leaves at most one group part done, and a merge is [open](#while-a-merge-is-open-in-a-group) in a group no longer than it must be. A group is also left part done when a finalize that starts after its member row moved puts it off; a later claim finishes it first, once the finalize ends.
   - **A group U left on their own** (U's row there has U's own `member.left` as the newest of their `member.left` and `member.joined` rows): leaving on your own is final for that row ([leaving a group](permissions.md#leaving-a-group)). So U isn't added to the team, U's row isn't touched, no share moves to U, and P keeps its row and its shares there, as a placeholder with no identities. Coming back after leaving stays unsupported, and a new invite can't help either: U's row blocks a second one (`uniq_group_person`).
   - **A pair or employer group U already has a row in:** such a group always has exactly two members, so P and U are its two sides, and joining them would leave it with one. It's left as above: U's row and team untouched, and P keeps its row and its shares there.

   These two are the merge's **kept groups** (the lead, 16:30 on #310): groups U left on their own, and pair or employer groups U already has a row in.
   - **Every other group:**
     1. If a statement in the group is `finalizing`, leave the whole group for the next run, P's member row included, so P's row doesn't move while the group's inputs and shares must wait. Do the same, logging P's and the group's IDs, if step 1's dates for the group can't be read: `mergeMembersJson` is `null`, fails `mergeMembersSchema`, or has no entry for the group. Step 3 never plans a posted row's items without them, so such a group keeps the merge unfinished.
     2. Add U to the group's team ("already a member" counts as done).
     3. In one database transaction: stage a guard write on the group's row (a fresh `rev`) and check again that no statement in the group is `finalizing`, so a finalize that starts meanwhile fails one of the two commits. Then, if U also has a member row in the group, keep U's row, set its `joinedOn` to the earlier of the two and delete P's row; otherwise repoint P's row to U. The write to the kept row also sets a fresh `rev`, so it's a real change even when U's row was already `active` with the earlier `joinedOn`, and a leave or removal that guarded U's row fails its commit ([concurrency](ledger.md#concurrency)). Then set the kept row's status as in [joining](#joining-a-group) and write `member.joined` by U. The same transaction stages a guard write on U's person row (a fresh `rev`) and checks that U has no `deletedAt`: a merge never joins a person whose account is being deleted, and a deletion that races it fails one of the two commits ([deleting an account](#deleting-an-account-m4), step 2). If U has `deletedAt`, the transaction rolls back, the team membership is taken back, and every merge into U stops. Both member rows are staged before they're checked, so a ledger write that guards one of them ([concurrency](ledger.md#concurrency)) runs again, and so does this step if one of them changed. If the transaction fails, take the team membership back, unless U has a joined row there. Once it commits, add U to the team again ("already a member" counts as done), as a join does: the first add may have found an old membership that the [nightly check](scheduling.md#step-6-nightly-check) then removed as stale.

   A row is finished once it no longer points at P, so a retry carries on with the rest.
3. **P's shares, inputs and identities, in batches** of at most 90 operations per database transaction, guard writes and `balances` row deletes included, skipping kept groups. Shares, inputs and templates are looked for in P's groups (`mergeGroupIds`), one group at a time (or IDs in chunks under the query filter's value cap) and never all of the list in one query, so a long list only spreads the merge over more claims. Identities are found by person, and so are reminders, except those in a kept group:
   - **Guards first:** a batch that changes a group's shares or inputs stages a guard write (a fresh `rev`) on that group's row, then checks that no statement in the group is `finalizing`. If one is, that group's work is left for the next `/claim` or hourly run. A batch that rewrites inputs or a schedule template also stages U's person-row guard and checks `deletedAt`, as step 2 does, so no input or template comes to name a person whose account is being deleted. Every writer of shares writes the group `rev` ([concurrency](ledger.md#concurrency)), which is how `GET /balances` knows a read was complete.
   - **Balances:** after the guard, a batch that changes a group's shares (repoints, combines, or deletes them with a void) reads that group's `balances` row and, if there is one, deletes it in the same transaction ([balances](ledger.md#balances)). `/balances` sums the shares until the nightly check builds the row again, so balances never show P's old figure under U's name. A row deleted meanwhile fails the batch, which runs again.
   - **Shares:** repoint `shares.personId` from P to U. If P and U have shares in the **same transaction**, combine them into one share (sum given and received) to keep [I-5](ledger.md#invariants). Both are staged, then read again, so two merges can't add P's share twice. This includes shares of locked transactions: the merge is the one writer allowed to change those, and only this way ([I-7](ledger.md#invariants)). No transaction's total changes, so every group still sums to 0 after each batch (I-1). A group's shares move after its templates and inputs, and only in that group, and only where U has a member row there: in one of P's groups where neither has a row any more (U's, once P's, removed since), P's shares stay. Each share batch stages a fresh `rev` on U's member row there, then checks that U is still joined, so a removal or a leave of U's that overlaps it fails one of the two commits, and one that commits first leaves P's shares where they are. Before the identities move, a member row or share of P's found outside the kept groups keeps the merge open and is logged by ID.
   - **Inputs:** P becomes U inside the stored inputs that name people: `transactions.inputJson` and `items.splitJson` of every transaction that **isn't void** (unposted ones, schedule occurrences included; posted ones, since an edit reads them again; and locked ones, since voiding their statement unlocks them), and `schedules.templateJson`. A locked row is renamed exactly as a posted one is, and nothing else on it changes ([I-7](ledger.md#invariants)): its total, status and `statementId` stay, and the rename changes no share, so a final statement's numbers don't move. A locked row the merge can't read (JSON it can't parse, or an input today's schema refuses) is logged by ID and left as it is. That row doesn't hold the merge open, and its group's inputs count as done, since nothing can change a locked row. A schedule's rewrite is staged with the scheduler's schedule guard (a write to the schedule row, then a check of the stored row), so an expansion in flight can't race it. Where U is already listed, the entries are added up: payer amounts, `exact` amounts, `percent` basis points and `weights` add; an `equal` split becomes `weights` (U 2, everyone else 1); a `days` split lists U once, since presence comes from U's kept member row. A `payment` or `loan` that isn't locked and whose two sides would both become U is voided instead, posted or not (its shares net to 0 for U either way). A locked one is never voided: a loan is renamed, and a payment keeps naming P, since a payment's two sides must differ. That payment doesn't hold the merge open. **A posted row's items** (locked ones included) are planned twice: as they are, with the members as they were before the merge (P's and U's member rows with step 1's dates, everyone else's as they are now), and renamed, with the members as step 2 left them, as an edit would plan them. Where the parts differ (an `equal` or `weights` split's leftover cent can fall elsewhere once two entries are one, and a `days` split counts U's kept row once), the item's split is written out as `exact` from the parts before, so no one's part of a posted item changes (a lead decision, #242 Q2 and B2). Each rewritten row is staged, then read again, so a row that was posted, edited, voided, locked or unlocked meanwhile makes the batch run again. One pure helper in `packages/core` does this rewrite.
   - **Where the input scan got to:** a group's transactions are scanned in `$id` order, a page of 100 at a time. Once a page's batches have committed, step 3 writes that page's last `$id` to the group's entry in `P.mergeCursorsJson` (`after`), and adds to its `left` the IDs of the page's rows left as they are (an unlocked row it can't read or rename). A later claim or hourly run starts the group's scan after `after`, so a big group finishes over several runs rather than starting again at its first row each time (a lead decision, #242 G). Each run reads the rows in `left` again first, 100 at a time, so one voided, fixed, locked or deleted since drops out, and one still left keeps the merge open. The group's inputs are done once a scan has reached its end and `left` is empty. The scan pages by `$id` (`Query.greaterThan`, [scaling](scaling.md)), so a cursor row deleted since changes nothing. The entry is written as P's other entries were read: staged, then P's row is read again, and a change meanwhile makes it read and merge them again, so two runs at once never lose each other's `left`. Each writes only a point it reached, so whichever wrote last is safe to carry on from. No row behind the cursor can come to name P: from step 1 on, every write resolves P to U, and from step 2 on, P has no member row in the group to be named by.
   - **Reminders:** repoint `reminders.toPersonId` from P to U, so the recipient limit counts the reminders P was sent toward U ([reminders](#reminders)). They're found by person (`idx_toPerson_sentAt`), not in P's groups; one in a kept group stays on P, as P's shares there do.
   - **Identities, last:** once nothing else outside the kept groups names P, repoint `identities.personId` from P to U. After step 1, only keys U verified are left, and at least one of them (the key the claim came through) points at P. So P still having an identity is what marks a merge unfinished.
   - Columns that only ever hold a person with an account (`createdBy`, `updatedBy`, `actorPersonId`, `invitedBy`, `ownerPersonId`, `reminders.sentBy`) can't name a placeholder, so they're left alone.
4. **Finished.** P is never deleted. A merge is finished when nothing outside the kept groups still names P: no identity, member row, share or reminder's `toPersonId` (checked by person, in every group but the kept ones), and, in P's groups (`mergeGroupIds`), no input or item split of a transaction that isn't void, locked ones included, apart from a locked payment between P and U and a locked row the merge can't read; and no schedule template. A batch put off for a group (a `finalizing` statement, or the time budget) therefore keeps the merge unfinished, whatever order the batches ran in. Until then, `/claim` (for persons whose `mergedInto` is the caller's person, `idx_mergedInto`) and `identity`'s hourly job ([finishing merges](#finishing-merges)) carry on with it; after that, they leave P alone. Meanwhile the [nightly check](scheduling.md#step-6-nightly-check) counts P's shares as `merging`. `/claim` stops starting batches after a time budget well inside the function's timeout.

A merge cut off partway leaves some of P's shares on P and some on U. Each batch keeps every group at 0, but until the next `/claim` or hourly run finishes it, balances show P and U as two people. A statement drafted or finalized between batches resolves P to U wherever P has no member row ([statements](statements.md#core-rules), rule 2), so it still adds up.

Statement snapshots are **not** rewritten. They are historical documents and keep the old display name; openings follow `mergedInto` when they're read ([statements](statements.md#core-rules)). The exception for locked transactions (their shares and stored inputs) is in [I-7](ledger.md#invariants) and [D-010](decisions.md#d-010-closed-periods-never-change).

### While a merge is open in a group

P's merge is **open** in a group G, per group (a lead decision, #301), while all of these hold:
- P has `mergedInto` set, and G is one of P's groups (`mergeGroupIds`);
- P has no member row in G, and U (P's `mergedInto`) has one: step 2 has given P's place to U. A kept group keeps P's row, and so does a group step 2 hasn't reached yet, so neither is open. Nor is a group where P's row was removed before step 2, so a write naming P there answers as for any non-member;
- G still names P, as each writer below says.

Whether P still has an identity doesn't matter. So a merge that can never finish (a row it can't read, say) holds only the groups that still name P, and a merge into a U whose account was deleted midway (deletion step 5 removes P's identities) stays open where it stopped (the desk's recommendation, #301).

In an open group, the writers below would count P as someone other than U. So they refuse, with `CONFLICT` and `details: { reason: 'merging' }`, and the app asks to try again shortly (a lead decision, #242 B1):
- **Leaving** (`POST /groups/{id}/leave`) and **removing a member** (`DELETE /groups/{id}/members/{memberId}`), when a person merged into the member (`idx_mergedInto`) has an open merge in G where P still has a share (`idx_group_person_date`). A removal is also refused while P is named in G's unposted transactions or schedule templates, as the removal rule checks for the member themselves ([leaving a group](permissions.md#leaving-a-group)). Otherwise a leave would check U's balance without P's shares, and the next claim would move them onto a U who has left. A removal would leave P's shares, or an unposted row naming P, with no member row ([I-3](ledger.md#invariants)).
- **`PATCH /transactions/{id}` and `/post`**, the scheduler's auto-post included, when the row's stored shares, stored input or item splits name a person P whose merge is open in its group (the row itself is what names P there). Both plan the row again with today's members, where U counts once, so P's part would move to others before step 3's rule for a posted row could write it out. `/void` and `/receipts` don't plan shares again, so they go ahead.

Each writer checks after its own guard writes. A leave or a removal, when a person merged into the member lists the group, stages a guard write on the group's row (a fresh `rev`) as well as on the member row, before it reads the balance or shares: step 3's batches write the group row, and step 2 writes both. With no such person, no batch can move shares onto the member there. A ledger write guards the group row, as always. So a writer that checked just before step 2 or a step 3 batch committed fails its commit and runs again, and is refused, or goes ahead once the batch has moved the last of what named P. A ledger write also checks before it plans the row, since planning refuses a person with no member row as not in the group, and the answer should be this one. With no merged persons, the check costs a leave or a removal one `persons` read (`idx_mergedInto`), and a ledger write two reads of the persons its row names, one before planning and one after the guard writes. For each merged person found, it reads P's and U's member rows in G and, for a leave or a removal, P's shares there (`limit 1`). The hourly job ([finishing merges](#finishing-merges)) keeps the window to about an hour, unless a group's statement stays `finalizing`. A merge into a deleted U, or one stuck on a row it can't change, keeps refusing in the groups it holds; voiding the rows there that name P ends it in that group.

### Finishing merges

A merge cut off partway carries on within about an hour, even if U never calls `/claim` again, and a big one over several runs ([#246](https://github.com/rojinc/ledgerly/issues/246)). `identity` runs every 60 minutes (`interval: 60`, so Appwrite picks the minute: [intervals, not cron](../engineering/environments-and-deploys.md#function-settings)), sent as `POST /` with the `schedule` trigger ([functions API](functions-api.md#identity)):

1. **A scheduled run finishes merges.** A signed-in call gets `FORBIDDEN`. Other runs without a JWT are handled as [function-side checks](permissions.md#function-side-checks) says.
2. **The budget** is the same as `/claim`'s, well inside the function's timeout, and it counts the walk below.
3. **Unfinished merges:** a merge is carried on exactly while P still has an identity, since identities move last (a merge into a deleted U has none left: deletion step 5 deletes them). The run pages through persons with `mergedInto` set (`idx_mergedInto`, 100 at a time) and, for each page, pages through the identities on them (`idx_personId`, only `personId` selected), keeping the persons that still have one.
4. **For each U** (the `mergedInto` person), in random order so a merge that can never finish doesn't take every run's budget: read U's person row just before its turn, skip U when `deletedAt` is set or there's no `userId`, then carry on U's merges with the same code `/claim` runs. It never marks a new merge (merge step 1, Mark P).
5. **After U's merges finish,** it reads U's Appwrite user once (`users.get`) and marks verified U's identities not yet verified whose key U's account verifies, as claim's step 2 does. So statement emails can use them before U's next login. A user that's gone (404) or labelled `deleted` is skipped.
6. **Logs and result:** counts only, per merge: `unfinished` found, `finished`, `skipped` (U deleted, or with no `userId`) and `cutOff` by the budget. Each merge's own log line holds IDs and counts, as for `/claim`.

**Runs that overlap are safe.** This job, U's own `/claim` and `account`'s hourly job can reach the same merge at once; two runs of this job can't, since its timeout is far under the hour. Every merge write is staged, then checked against the stored rows, so a change another run made first fails the batch, which runs again and finds it done. Steps 2 and 3 guard U's person row and check `deletedAt`, so a deletion that starts meanwhile fails one of the two commits ([deleting an account](#deleting-an-account-m4), step 2).

U didn't call it, but U started the merge by verifying the key, so finishing it is U's own action ([D-016](decisions.md#d-016-being-added-to-a-group-doesnt-make-you-a-member-you-join)). U isn't told which groups they joined. Accepted for v1: a merge that can never finish is tried every hour, and its log line is the alert.

## Invites

An invite is a convenience: a link that tells someone they've been added and helps them sign up. Claiming works without one, as long as the person verifies the key that was stored for them: the email, or the phone if no email was given ([adding someone](#adding-someone-to-a-group)).

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

## Reminders

Someone owed money in a lend & borrow group can email the other person a reminder of the amount, at an address they type (F-63, [#56](https://github.com/rojinc/ledgerly/issues/56)). Email only for now: SMS reminders follow SMS invites ([#40](https://github.com/rojinc/ledgerly/issues/40)) and add `phone` to the body in their own contract change.

`identity POST /reminders` with `{ id, groupId, email }` (`sendReminderBodySchema`; `id` is a client `ID.unique()`):

1. **The body** must parse, otherwise `VALIDATION_FAILED`.
2. **Who:** a joined member of the group (`requireMember`) with the role `admin` or `member`, with a verified email, as for invites. A `placeholder`, `left` or non-member caller gets `NOT_A_MEMBER`, a viewer or an unverified caller `FORBIDDEN`, an archived group `ARCHIVED`. A group that isn't a `pair` gets `VALIDATION_FAILED`: houses have settle up.
3. **A retry:** if a `reminders` row with ID `id` exists, anyone but its sender in its group gets `CONFLICT`. The sender gets its stored `{ sentAt }`, whatever the rest of the body says (an exception to [idempotency](functions-api.md#idempotency)). The email is sent again, with the same Resend key, only when **both** hold: `sentAt` is under 23 hours old, so the key is still live and Resend delivers each `id` at most once; and steps 4 and 5, and the recipient's `deletedAt` check (step 6.2), pass again for the address typed now. Otherwise nothing is sent. So a retry can't be used to send one reminder again after the key expires, or to an address the first one wasn't checked against.
4. **Owed to the caller:** the caller's net in the group, read with the same helper as `GET /balances`, must be above 0. That helper is `readGroupNets(db, group)` in `packages/server/src/ledger/balances.ts`, which #56 moves there unchanged from `functions/ledger/src/routes/balances.ts`. Otherwise `VALIDATION_FAILED` ("Nothing is owed to you in this group") and nothing is sent.
5. **The recipient** is the person the pair's other member resolves to (`mergedInto` followed to the end, as `resolvePerson()` reads it), whatever their member status; the caller never names them. This person is `toPersonId`, the one guarded in step 6 and the activity row's `subjectPersonId`. The address typed, after `normalizeEmail()`, must be an identity whose person resolves to that person (mid-merge, P's identities may still be on P), otherwise `VALIDATION_FAILED`, with a fixed message that never repeats the address. So the route can't send "you owe me" to an address the group doesn't already hold for that person, and it never picks an address the caller didn't type. A deleted person has no identities left, so a reminder to a former member gets this same answer and doesn't show the deletion.
6. **Guards, then checks, in one database transaction:**
   1. Stage a guard write (a fresh `rev`) on the sender's and the recipient's `persons` rows, as for invites, so parallel requests can't pass a count together.
   2. Read both rows again. A recipient with `deletedAt` (a deletion that started meanwhile) gets the same `VALIDATION_FAILED` as a wrong address; a sender with `deletedAt` gets `UNAUTHENTICATED`.
   3. **Rate limits** (`REMINDER_LIMITS`, rolling): at most 1 per sender per group in the last 3 days, 3 per recipient person in the last 7 days from all senders, and 20 per sender in the last 24 hours across groups. Otherwise `RATE_LIMITED`, one message for all three.
7. **Stage and commit:** the `reminders` row (ID `id`, `channel: 'email'`, `sentAt` now) and a `reminder.sent` [activity](data-model.md#activity) row: `actorPersonId` = the sender, `subjectPersonId` = the recipient, summary `was sent a reminder` (the feed shows "<subject> was sent a reminder"), no `changesJson`. **Commit before sending,** so N parallel requests with different `id`s can't all count 0 and all send: the guards fail every commit but one.
8. **Send** through Resend with the idempotency key `person-reminder-<id>`. A failed send answers `INTERNAL` and still counts toward the limits, as for invites; the app retries with the same `id` (step 3), and the same key stops a second delivery. On a re-send, Resend's `invalid_idempotent_request` means the key was used already, with other content: the reminder counts as sent (200). `concurrent_idempotent_requests` means a parallel call is still sending it and may yet fail, so it answers `INTERNAL`, and the app tries again.
9. **The email:**
   - **Subject:** "You have a payment reminder", fixed: the sender's name is free text they chose, so it stays out of the subject.
   - **Body:** "{sender} sent you a reminder that you owe them {amount}." and "If you've already paid, let them know so they can record it.", and one link to the app (`APP_URL`).
   - `{sender}` is the sender's `members.displayName` in that group, put on one line (each run of spaces and line breaks becomes one space), cut to 40 characters as people see them, so an emoji isn't split (with "…"), and HTML-escaped. `{amount}` is the whole balance in the group's currency.
   - **Nothing else:** no recipient or group name (both are what the sender calls them), no transactions, no note (a phishing risk) and no `replyTo` (it would show the sender's account email).

The response and the email are the same whether the recipient is a placeholder without an account, one with an account, or a joined member. The address typed and the amount are stored nowhere, and logs hold IDs, error codes and Resend's email ID only.

**Accepted risks:**
- Hitting the recipient limit tells the sender that someone else reminded that person this week.
- Whether a typed address matches tells the sender which address the person is known by. The check comes before the limits and a failed one stores nothing, so guesses aren't counted yet, exactly as for an invite's address check (step 2). It only answers for the one person the sender shares a pair group with, and never says whether they have an account. Counting failed checks for both is [#274](https://github.com/rojinc/ledgerly/issues/274).
- **The sender's name is free text** in the body, up to 40 characters: enough for a short misleading phrase, not a message. Invites have the same exposure (a follow-up).
- **One inbox can be several persons** (`a+1@x`, `a+2@x`): each has its own recipient limit. Accepted.
- **Retention:** `reminders` rows hold person and group IDs only, and are kept until either person's account is deleted (or a purge). Pruning old rows is a later follow-up.

## Password notice

When an account's password is set for the first time or changed, the account's verified email gets a notice, so a stolen session that sets a password is noticed ([#236](https://github.com/rojinc/ledgerly/issues/236)). It goes with the 24-hour [deletion refusal](#refusals).

The `identity` function subscribes to two Appwrite events: `users.*.update.password` (a password set or changed while signed in) and `users.*.recovery.*.update` (a [recovery](https://github.com/rojinc/ledgerly/issues/290) reset). A reset fires only the second, and Appwrite matches event names exactly (Appwrite 1.8.1, `account.php` and `Workers/Functions.php`). **It never subscribes to `users.*.recovery.*.create`, `users.*.recovery.*` or `users.*`:** the create event's payload carries the recovery secret in plain text. Appwrite runs it as `POST /`, an [event run](permissions.md#function-side-checks), with the event's name in `x-appwrite-event` and the user (or, for a reset, the spent token) as the body:

1. **Who:** a signed-in call gets `FORBIDDEN`. Any other call without a JWT gets `UNAUTHENTICATED` before the route, as for a missing JWT.
2. **The user:** it takes only the user ID: from the event's name (`users.<userId>.…`), or, if that names none, the body's `$id`. Then it reads the user again with `users.get`. It trusts nothing else in the body, and never logs or stores it. Reading the ID from the name also fits a recovery event, whose body is a token, not a user.
3. **When it sends:** only if the user still exists, `passwordUpdate` is under 60 minutes old (`PASSWORD_NOTICE_WINDOW_MINUTES`), and the account email is verified. Otherwise it sends nothing.
4. **The email** goes to that verified address, through Resend with the idempotency key `password-notice-<SHA-256 hex of "<userId>:<passwordUpdate>">`, so each change sends at most one email.
   - It says when the change happened, in the profile's time zone (UTC with no profile), and "If this wasn't you, reset your password now", with a link to the app's sign-in page (`APP_URL`).
   - It holds no password, token, or link that signs anyone in.
5. **Logs** hold the user ID and the outcome only: `sent`, `stale`, `unverified`, `gone`, or `failed` with the email error's type.

A forged or replayed call can do nothing new: at worst it asks again, within the hour, for the email the real event already sent, and Resend's key drops that copy. **Accepted:**
- A phone-only account gets no notice until SMS can carry it (#175).
- Other sessions are signed out only for a change through the password route, by the project's session invalidation setting ([environments](../engineering/environments-and-deploys.md#environments)). A recovery reset leaves them signed in; [#290](https://github.com/rojinc/ledgerly/issues/290) handles that.
- A notice to the old address when the email or phone changes is #268.
- **A first password set through an email or phone change.** Appwrite may set a first password through an email or phone change on an account that has none (made with an email code). That fires only `users.*.update.email` or `.phone`, so no notice goes. #268's notice to the old address covers that path; the 24-hour deletion refusal holds either way, since `passwordUpdate` is set.
- A send that fails (a Resend outage, say) isn't retried: Appwrite doesn't run an event again. The run logs `failed`.
- After the deploy, the lead checks on `ledgerly-dev` that setting a first password fires `users.<id>.update.password` and a recovery reset fires `users.<id>.recovery.<tokenId>.update`, each with the user ID in `x-appwrite-event`.

## Deleting an account (M4)

`account POST /delete` ([functions API](functions-api.md#account)), from the delete screen ([#50](https://github.com/rojinc/ledgerly/issues/50)). Deletion has its own function, `account`, so `identity` (which runs bootstrap for every new user) never holds `users.write` or file access. **Deleting means anonymising.** Shares, statements and balances point at the person ([I-3](ledger.md#invariants)), so the `persons` row stays: `deletedAt` set, `userId` cleared, `displayName` "Former member", and no permissions. Their identities, profile (business details included), the invites and reminders they sent or were sent, and the Appwrite user are deleted ([step 5](#order) has the full list). There is no undo or grace period in v1: typing DELETE is the confirmation.

### Each group they joined

For every group where they have an `active` or `left` member row, its team decides:

- **Purge, if nobody else is in the team.** This is always true of the personal group. It deletes the team and sets `archivedAt` first, so jobs and writes stop. Then the group's files go, then its rows, in batches of at most 90 writes (each transaction with its shares and items, and its receipts taken off ([receiptFiles](data-model.md#receiptfiles)), member rows after all shares, the group's `balances` row with the first batch, and its `reminders` rows, found by `idx_groupId`, in batches too), then any placeholder left with no member row anywhere (its person and identities). A file is deleted only when its permissions are exactly `read("team:<the purged group>")` and its [`receiptFiles`](data-model.md#receiptfiles) row lists no transaction outside the purged group, so a file shared with another group's transaction stays. A file with no row (attached before the ledger kept them, until the backfill has run) counts as listed elsewhere and stays. The purge never deletes `receiptFiles` rows itself: taking the receipts off leaves the rows of the files it deleted detached, and scheduler step 5 deletes those rows about 25 hours later (their files already gone, so they count as skipped). A placeholder is deleted only after a staged write, and only if, re-checked after it, `isPlaceholder()` still says so (a merged person is kept) and it still has no member row.
- **Keep, otherwise.** In one transaction, with a fresh group `rev`: their member row becomes "Former member", `left` and `viewer`, with `leftOn` set as leaving sets it (today in the group's time zone, or `joinedOn` if that's later) if it's empty, so `days` bills stop counting them; and a `member.left` activity row by them, with `subjectPersonId` = their person and no name, so the row counts as leaving on their own ([leaving](permissions.md#leaving-a-group)). Then, in this order: **the schedules** in the group that they created, or whose template names them, end on the earlier of their stored end and today, as `POST /schedules/{id}/end` does (occurrences after it that can still change are removed, so no new occurrence names a deleted person; both use `endScheduleOn()` in `packages/server/src/scheduler/end-schedule.ts`). One that has already ended by today, been made up to its end, and has no occurrence left that an end would remove (`scheduled` or `due`, not edited, dated after its end and from today), is left as it is, so an end cut off before its deletes runs again. One that hasn't started yet (`startsOn` after today) and has no posted occurrence is deleted instead, with its occurrences, as `DELETE /schedules/{id}` does (`deleteScheduleRows()`, which takes their receipts off), rather than ending before it starts. A template that can't be read names nobody, and its schedule ID is logged; **then the archive** (with a `group.archived` row by them, as an admin's archive writes), for a kept `employer` or `pair` group where they were the only joined admin, or a kept house that can't have another admin (below), since ending a schedule in an archived group is refused; **then leaving the team, last**, so a crash before it leaves the group to be finished, never with its schedules still running.

**A rerun never decides again.** What a group's state says decides how a rerun carries on, never the team as it is by then:

- **The group's team is gone:** a purge was started, so it carries on. Their own member row, deleted last, ends it.
- **Their member row shows the keep's own write ("Former member", `left` and `viewer`), with their own `member.left` dated on or after `deletedAt`** (`leftOnTheirOwn()` with `deletedAt` as the earliest date, rather than the member row's `$createdAt`)**:** the keep's transaction is done. The schedule, archive and team steps are then retried on every run until step 6, even if they're no longer in the team or everyone else has since left it; each is safe to repeat. A `left` row without the keep's write (their own leave that committed after step 2, or before it with a crash after) still has their name, so it gets the keep.
- Anything else is decided from the team, as above.

**Changes after the checks.** Step 1's checks can be overtaken before a group's turn comes, and a deletion can't be refused after step 2. A kept house left with no other joined admin (say a placeholder joined a house they were alone in, or the other admin left meanwhile) is archived, like an employer or pair group. A group with a statement `finalizing` isn't archived or purged until the finalize ends, and one with a timer someone else started still running isn't archived until it's stopped or voided (a timer in an archived group can't be): the group is left for the next run.

**A stuck finalize.** A `finalizing` statement that hasn't been written for an hour was left by a crash. It began after step 1 (which refuses one they could finish), and nobody left can resume it. So it isn't waited for: a kept group is left unarchived, with its ID logged, and the deletion carries on. Not archiving it costs nothing, since the statements cron starts nothing new for a group with a finalizing statement.

Groups where they're a `placeholder` (never joined) are left exactly as they are: changing them would show the other members they had an account ([D-016](decisions.md#d-016-being-added-to-a-group-doesnt-make-you-a-member-you-join)).

### Refusals

Checked in this order, and each changes nothing:

1. **The body isn't `{ confirm: 'DELETE' }`:** `VALIDATION_FAILED`.
2. **The session is old.** The route reads the session ID from the caller's verified JWT and loads that session (`users.listSessions`). If it was created more than 10 minutes ago (`REAUTH_WINDOW_MINUTES`), it answers `FORBIDDEN` with `details: { reason: 'reauth' }`. The app asks them to sign in again (password or email code) and retries. So a stolen session that's been open a while can't delete the account. The check fails closed: a JWT with no session ID, or a session that `users.listSessions` doesn't return, gets the same answer.
3. **The password changed recently.** If the user's `passwordUpdate` is less than 24 hours old (`RECENT_PASSWORD_CHANGE_HOURS`), the answer is `FORBIDDEN` with `details: { reason: 'recent_password_change' }`. A stolen session on an account without a password could otherwise set a first one (#203 allows that without an old password), sign in fresh and pass step 2. Appwrite also sets `passwordUpdate` when an account without a password changes its email or phone, so those are caught too. Accepted: a new account that set a password today can't delete it until tomorrow.
4. **A timer is running** in a group that isn't archived: `CONFLICT`. They stop or void it first. A timer left in an archived group can't be stopped, and doesn't block deletion ([timer shifts](scheduling.md#timer-shifts)).
5. **A statement is being finalized** in a group where they're the only joined admin: `CONFLICT`. Only an admin can finish a finalize, so they finish it first: once they're gone nobody could, and the group could never be archived.
6. **They're the only joined admin of a house that isn't archived and has another `active` member** who could be made admin: `VALIDATION_FAILED` with `details: { groupIds }` (an exception to `details` holding schema issues). They make someone else admin first: the rule leaving uses ([leaving](permissions.md#leaving-a-group)). A kept house where nobody else could be admin (it's archived, or everyone else in its team has moved out) is archived instead, as an employer or pair group is. A house with nobody else in its team is purged, as above.

Non-zero balances don't block it; the delete screen warns about them.

### Order

1. The refusal checks.
2. Set `persons.deletedAt` and `displayName` "Former member", with a fresh `rev` (a [guard write](ledger.md#concurrency)). **This is the point of no return:** from here every step runs to the end, and none is undone. A call after this skips the checks (apart from the body) and carries on.
3. Label the Appwrite user `deleted` (`users.updateLabels`), block them and delete their sessions, so an old JWT fails `account.get()` (`UNAUTHENTICATED`). A 404 counts as done.
4. The groups, one at a time, as above.
5. Only once **every** group is done: delete their identities, the identities of any person still being merged into them (`mergedInto` = theirs, `idx_mergedInto`: a merge moves identities last, so an unfinished one leaves their verified key there), the invites they sent, the invites sent to their member rows in groups they joined (each holds the address it went to; one to a group where they're a placeholder stays, as the group does), the reminders they sent or were sent, a person still being merged into them included (`idx_sentBy_sentAt`, `idx_toPerson_sentAt`), and their profile. Their `active` and `left` member rows are listed once more first: a row that a join or a new group committed after step 4 listed them waits for the next run.
6. Clear `persons.userId` and the row's `read("user:<userId>")` permission.
7. Delete the Appwrite user (a 404 counts as done).

Step 6 comes before step 7 because Appwrite user IDs are chosen by the client at sign-up: once the user is deleted, someone who knows the ID could sign up with it, and must not find a person to bootstrap into. For the same reason, **a person with `deletedAt` is never resolved from a `userId`** (bootstrap, claim, join and `requireMember()` skip it, as if there were no person). Claim's and join's writes also stage a [guard write](ledger.md#concurrency) on the person and check `deletedAt` again, so a deletion that passes step 2 after the lookup gets nothing written for it. So `/bootstrap` refuses with `UNAUTHENTICATED`, writing nothing, a user labelled `deleted` (checked again after it stages its writes) or one with a person whose `deletedAt` is set, and step 7 first looks up persons by `userId` once more: a person without `deletedAt` there (made by a bootstrap that committed after step 2) is purged before the Appwrite user is deleted.

Every step can be repeated: a crash after any of them, then a rerun, leaves the same rows. The route works for up to 20 seconds and returns `{ deletedAt, finished }`. The hourly job (`account POST /`, scheduled only) finishes any person with `deletedAt` set and `userId` still set (`persons.idx_deletedAt`), and deletes any Appwrite user labelled `deleted` whose person no longer names it. It skips deletions started in the last minute, which the route may still be running.

### What is kept, and why

- **Final statements, their snapshots and PDFs in kept groups,** as issued, ABN and bank details included: other members already hold these documents ([D-010](decisions.md#d-010-closed-periods-never-change)). Merges don't rewrite them either.
- **Receipts on kept transactions, and text other people typed** (descriptions, notes, void reasons).
- **Groups they left on their own:** their member row is renamed "Former member"; their shares and history stay, like any kept group's. They aren't in `my-records.csv`, since the user can no longer read those groups: export gap, accepted for v1.
- **Receipts they uploaded but never attached** keep their own permissions until the scheduler's clean-up deletes them, about 24 hours after upload ([step 5](scheduling.md#step-5-receipt-clean-up)).
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
