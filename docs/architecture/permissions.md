# Permissions

There are two layers:

1. **Appwrite permissions decide who can *read*.** Every group is an Appwrite Team, and its rows carry `read("team:<groupId>")`.
2. **Functions decide who can *write*.** Clients have no write permission on any table. Each function checks the caller's `members` row (role and status) before it changes anything.

Keeping authority in one place (`members.role`) means there is one source of truth. Appwrite team roles are **not** used for authorization. ([D-004](decisions.md))

## Teams

- Team ID = group row ID. Created with the server API key when the group is created: by the `identity` function for the personal group, at bootstrap, and by the `groups` function for every other group.
- A person is a team member only if they have a user account (`persons.userId`) **and** have joined the group. Placeholders, including registered people who haven't joined yet, are in `members` but not in the team ([D-016](decisions.md)).
- Team memberships are created, changed and deleted **only by functions**, with the server key. Clients never call the Teams API to change membership.
- After a group is created, only the `identity` function adds people to its team: when a claim links a placeholder to a new account, or when a registered person joins a group they were added to ([identity](identity-and-invites.md#joining-a-group)).
- The scheduler's [nightly check](scheduling.md#step-6-nightly-check) removes a membership over an hour old when none of its user's persons has an `active` or `left` row in the group, or only a `left` row they left on their own, unless the person is being deleted: one left by a join, a merge or a leave that stopped between its Teams call and its database transaction. It puts one back if a join or a merge lands, or the person's account deletion starts, while it removes it: deletion decides its reruns from the team, and the membership goes when the Appwrite user is deleted. Those are the scheduler's only team writes.

## Row permissions by table

| Table | Row permissions | Set by |
| --- | --- | --- |
| `persons` (registered) | `read("user:<userId>")` | `identity`; `account` removes it on deletion |
| `persons` (placeholder), `identities`, `invites`, `reminders`, `balances`, `receiptFiles`, `checkpoints`, `changeNotices` | none | n/a |
| `profiles` | `read("user:<userId>")` | `identity`; `account` deletes the row |
| `groups`, `members`, `transactions`, `shares`, `items`, `schedules`, `statements`, `activity` | `read("team:<groupId>")` | the writing function |

Table-level permissions: **none** on every table. Row security is on everywhere. A user can read a row only if the row grants it. Appwrite grants access if *either* the table or the row allows it, so table-level permissions must stay empty.

## Roles

| Capability | admin | member | viewer |
| --- | :---: | :---: | :---: |
| See the group and its transactions | ✓ | ✓ | ✓ |
| Add transactions | ✓ | ✓ | — |
| Edit or void transactions **they created** | ✓ | ✓ | — |
| Edit or void **anyone's** transactions | ✓ | — | — |
| Create and edit schedules | ✓ | own only | — |
| Add members and send invites (invites need a verified email) | ✓ | house only | — |
| Remove members, change roles, change settings | ✓ | — | — |
| Close a period now; finalize, send, void, reissue or discard statements | ✓ | — | — |
| Archive or unarchive the group | ✓ | — | — |
| Delete the group, once it's archived and nobody else is in its team ([deleting a group](identity-and-invites.md#deleting-a-group)) | ✓ | once it has no joined admin | once it has no joined admin |

Nobody can edit or void a **locked** transaction, admins included ([I-7](ledger.md#invariants)).

Members who haven't joined (`placeholder`) keep their role but have no access, and get no automatic notifications or reminders until they join. A reminder, invite or invoice someone sends them on purpose is different ([joining a group](identity-and-invites.md#joining-a-group)).

### Default roles by group type

| Group type | Creator | Others |
| --- | --- | --- |
| `personal` | admin (only member) | none allowed |
| `employer` | admin (the worker) | counterpart (employer) = viewer |
| `house` | admin | member |
| `pair` | admin | counterpart = admin |

### Leaving a group

- **Moving out (house):** set `leftOn` and change the role to `viewer`. A joined member's status becomes `left`; they keep read access so they can see and settle what they owe. Someone who never joined stays `placeholder`. Clearing `leftOn` turns `left` back into `active` only for someone who moved out and is still in the team, never for a row that left on its own (it has its own `member.left`): leaving on your own is final for that row.
- **Removing completely:** only allowed when the person has no shares in the group and isn't named in a transaction that isn't posted yet (`scheduled`, `running` or `due`, including its items' splits) or in a schedule's template, and didn't create a schedule whose template names no payers (the scheduler charges its creator for the trial occurrence and its auto-posts, [scheduling](scheduling.md)). Otherwise use `left`. While a person merged into them still has shares in the group, or is named there as above, with that merge open in the group ([merging](identity-and-invites.md#while-a-merge-is-open-in-a-group)), removing them is refused with `CONFLICT`; so is their leave below while that person still has shares there.
  - **The member row goes; the person stays.** A placeholder's person and identities, and the invites to the row, stay for now. So adding the same address again finds the same person whether or not it has an account, and for those 30 days a removal tells an admin nothing about the address ([D-016](decisions.md)). The invites also keep counting toward the invite limits, until [step 5b](scheduling.md#step-5b-invite-clean-up) or step 5c deletes them, long after any limit's window.
  - **The person's write comes first.** After the member row's delete is staged, the removal stages a fresh `rev` on the person ([guard write](ledger.md#concurrency)). When the row was a lone placeholder's last (`isPlaceholder()`, so a merged person isn't one, with no other member row anywhere), it also stages `orphanedAt` = now. Then it reads the stored person and its other member rows again, and answers `CONFLICT` if whether it's a lone placeholder's last row changed. So of two removals of a placeholder's last two rows at once, one commit fails, and its retry sets `orphanedAt`. An invite to the row that read it before the removal committed guards the person too, so one of the two commits fails.
  - **30 days later,** [scheduler step 5c](scheduling.md#step-5c-placeholder-clean-up) deletes the identities of a placeholder with that `orphanedAt` that no member row names, and the invites sent to those keys, and replaces its name with "Former member". Its row stays, so the posted rows and activity that name it still find it, as for a deleted account. One re-added, claimed or merged since is kept as it is, and so is a person with an account.
- **Leaving voluntarily:** a member may leave once their balance is 0 and another joined admin stays (the last joined admin hands over first). In one database transaction their status becomes `left`, their role `viewer` and `leftOn` today if empty; then their team membership is removed. Their history stays. Coming back after leaving voluntarily isn't supported in v1, so someone who left can only be a `viewer`. `leftOn` is never before `joinedOn`. Someone already marked `left` (moved out) still needs a balance of 0 to leave; their leave then writes their own `member.left`, with a guard write on their row, so it's final for that row too and a move back in racing it fails. A retry of their own leave that was cut off before the team step skips the balance check, so it can finish even if a share landed in between. It counts as their own leave when the newest `member.left` or `member.joined` row they wrote since that member row was created is `member.left`. Newest goes by when the row was written (`$createdAt`, which Appwrite stamps), then by `at`: `at` is the request's start, so a merge's `member.joined` can carry an earlier `at` than a leave written while the merge ran ([#457](https://github.com/rojinc/ledgerly/issues/457)). Leaving can be finished in an archived group. In an archived group, only someone whose row is `left` can leave: someone who moved out, or someone finishing their own leave (anyone else gets `ARCHIVED`). The last person in its team can't start a leave there: they delete the group instead (`VALIDATION_FAILED`, [#486](https://github.com/rojinc/ledgerly/issues/486)), so its rows are never left where nobody can read them. A retry that only has the team step left is never refused. Two such leaves at once (or one cut off before its team step, and retried after the other) can both go through, leaving the team empty: accepted, since it takes two people racing in a group that's already rare (the lead on #486).
- **Deleting an account:** the only joined admin of a house that isn't archived and has another `active` member hands over first, as for leaving: deletion is refused (`VALIDATION_FAILED`, naming the houses). A kept employer or pair group where they're the only joined admin, or a kept house where nobody else could be admin, is archived instead, and the last person still in its team can delete it, whatever their role ([deleting a group](identity-and-invites.md#deleting-a-group)); a house with nobody else in its team is purged. Their kept member row gets a `member.left` row by them, so it counts as leaving on their own ([deleting an account](identity-and-invites.md#deleting-an-account-m4)).

## Function-side checks

Every HTTP request runs step 1 once, in `createHandler`, except a scheduled run or an event run (below). Every route that changes data then runs steps 2–5 (helper `requireMember()` in `packages/server`):

1. Verify the caller: call Appwrite's `account.get()` with the JWT from the `x-appwrite-user-jwt` header, on a separate node-appwrite client with the function's endpoint and project, `setJWT` and no API key. Pass the header exactly as received; never split or trim it. The returned user's `$id` is the caller. If the JWT is missing, or Appwrite rejects it, return `UNAUTHENTICATED`. Never trust `x-appwrite-user-id` (see [Function execute permissions](#function-execute-permissions)).
2. Load the caller's person (`persons.userId = caller`). A person with `deletedAt` counts as none ([deleting an account](identity-and-invites.md#order)), so step 3 answers `NOT_A_MEMBER`.
3. Load their `members` row for the target group. If it is missing or `status = placeholder`, return `NOT_A_MEMBER`. A `left` row counts only while the caller is still in the group's team (moved out); someone who left on their own is out of the team and gets `NOT_A_MEMBER` too. Routes that load a transaction, statement or schedule by its ID and then check membership in that row's group answer `NOT_FOUND` instead of `NOT_A_MEMBER`, the same as for an ID that doesn't exist (helper `requireMemberOf()`; [functions API](functions-api.md)). The group and member routes, such as `/groups/{id}/leave`, `/join` and `/members/{memberId}`, still answer `NOT_A_MEMBER`.
4. Check the role against the table above. If it fails, return `FORBIDDEN`.
5. If the group is archived, return `ARCHIVED`.

Routes that don't act as a joined member of an existing group skip steps 2–5, never step 1: `groups POST /groups`, `identity GET /groups/pending` and `POST /groups/{id}/join` (join needs the caller's own member row instead), and the other identity routes except `POST /invites`, which checks the role as in step 4.

Scheduled jobs run with the server key and no caller. They write as the system and record `actorPersonId = null` in `activity`. A run is a scheduled job only when `x-appwrite-trigger` is exactly `schedule` (`ctx.scheduled` in `createHandler`). A missing JWT never makes a request a scheduled job; on any other request it means `UNAUTHENTICATED`, except on a route declared public. Only `/health` is public, and it returns nothing about the caller or the project. (A forged `X-Appwrite-Trigger: schedule` arrives merged as `schedule, http`, so the exact match fails closed.)

**Event runs** are the third kind of run without a JWT. A run is one only when `x-appwrite-trigger` is exactly `event` and there's no JWT (`ctx.event` in `createHandler`), and only a route that opts in accepts it. Any other route answers it `UNAUTHENTICATED`, as for a missing JWT. Today only `identity POST /` opts in, for the [password notice](identity-and-invites.md#password-notice) and the [email and phone change notice](identity-and-invites.md#email-and-phone-change-notice). It's safe because an event route:
- trusts nothing in the body but a user ID;
- reads everything it decides from again, server-side;
- has an effect that is idempotent.

So a forged or replayed call can do nothing the real event didn't already do. A forged `X-Appwrite-Trigger: event` fails the exact match as for `schedule`, and a call with a JWT is never an event run.

## Storage

- `receipts`: only verified users can upload (`create("users/verified")`). The client must set `read("team:<groupId>")` on the file. Before a write attaches a file that isn't already on the stored row, the `ledger` function checks that:
  - the file is in the `receipts` bucket;
  - its permissions include `read("team:<groupId>")` for the transaction's group;
  - its `mimeType` is `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` or `application/pdf` (`image/heif` because a `.heic` photo can report itself as HEIF; the bucket takes no `.heif` files);
  - its upload is complete (`chunksUploaded` equals `chunksTotal`). An unfinished upload's remaining chunks could still change its content and permissions;
  - the scheduler isn't deleting it: its [`receiptFiles`](data-model.md#receiptfiles) row has no `deletingAt`. The ledger reads the rows before it looks at the files. After staging its writes it reads them again, as committed, and runs again if any changed ([concurrency](ledger.md#concurrency)).

  Any failure gives `VALIDATION_FAILED`, naming `receiptFileIds.<index>`, with the same message for every failure. A missing file and another group's file get the same answer, so the reply never shows whether a file ID exists. Only after every file passes does the ledger set each file's permissions to exactly `read("team:<groupId>")`, and it does so **before** the row commits. That removes any wider read and any `update` or `delete` the uploader granted themselves, so a stored ID never points at a file its uploader can still swap or delete behind a locked transaction. A retry passes the check again. Taking a file off a transaction leaves the file and its permissions as they are.

  A file that no transaction lists is deleted by a later scheduler run, once it's past these times ([step 5](scheduling.md#step-5-receipt-clean-up)):
  - 24 hours after its upload, for a file that was never attached;
  - 24 hours after it was taken off its last transaction.

  Until then it keeps the permissions it has.
- `statements`: only the `statements` function writes. Files are readable by the group's team.

## Function execute permissions

| Function | Execute |
| --- | --- |
| `ledger`, `groups`, `identity`, `account` | `users` (any signed-in user; the function checks the rest) |
| `scheduler`, `statements` | `users` for their HTTP routes; scheduled runs need no execute permission (`account`'s hourly deletion job and `identity`'s merge job too) |

Execute is `users` only, never `any` or `guests`, and no function gets a custom domain. Appwrite serves a function's domains (the generated `*.appwrite.run` one and any custom one) only when execute includes `any` or `guests`, so the only way in is `createExecution` by a signed-in user. No user is ever made an impersonator, because Appwrite's impersonation headers would let them execute as someone else.

**Why functions verify the JWT.** Appwrite refuses execution headers that start with `x-appwrite` only when they are lower-case. On `ledgerly-dev` (2026-10-18), a client sent `X-Appwrite-User-Id` and `X-Appwrite-User-Jwt` with made-up values in an execution's `headers`, and the function received them. For an anonymous caller (the test function had execute `any`) `x-appwrite-user-id` was the forged value. For a signed-in caller it was `"<forged>, <real>"`. `account.get()` accepts a JWT only if Appwrite signed it, it hasn't expired and its session still exists, so a made-up or merged value fails.
