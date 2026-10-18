# Permissions

There are two layers:

1. **Appwrite permissions decide who can *read*.** Every group is an Appwrite Team, and its rows carry `read("team:<groupId>")`.
2. **Functions decide who can *write*.** Clients have no write permission on any table. Each function checks the caller's `members` row (role and status) before it changes anything.

Keeping authority in one place (`members.role`) means there is one source of truth. Appwrite team roles are **not** used for authorization. ([D-004](decisions.md))

## Teams

- Team ID = group row ID. Created by the `groups` function with the server API key when the group is created.
- A person is a team member only if they have a user account (`persons.userId`) **and** have joined the group. Placeholders, including registered people who haven't joined yet, are in `members` but not in the team ([D-016](decisions.md)).
- Team memberships are created, changed and deleted **only by functions**, with the server key. Clients never call the Teams API to change membership.
- After a group is created, only the `identity` function adds people to its team: when a claim links a placeholder to a new account, or when a registered person joins a group they were added to ([identity](identity-and-invites.md#joining-a-group)).

## Row permissions by table

| Table | Row permissions | Set by |
| --- | --- | --- |
| `persons` (registered) | `read("user:<userId>")` | `identity` |
| `persons` (placeholder), `identities`, `invites` | none | n/a |
| `profiles` | `read("user:<userId>")` | `identity` |
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
| Add members and send invites | ✓ | house only | — |
| Remove members, change roles, change settings | ✓ | — | — |
| Finalize, send or void statements | ✓ | — | — |
| Archive the group | ✓ | — | — |

Nobody can edit or void a **locked** transaction, admins included ([I-7](ledger.md#invariants)).

Members who haven't joined (`placeholder`) keep their role but have no access, and get no notifications or reminders until they join.

### Default roles by group type

| Group type | Creator | Others |
| --- | --- | --- |
| `personal` | admin (only member) | none allowed |
| `employer` | admin (the worker) | counterpart (employer) = viewer |
| `house` | admin | member |
| `pair` | admin | counterpart = admin |

### Leaving a group

- **Moving out (house):** set `leftOn` and change the role to `viewer`. A joined member's status becomes `left`; they keep read access so they can see and settle what they owe. Someone who never joined stays `placeholder`. Clearing `leftOn` turns `left` back into `active` only while the person is still in the team.
- **Removing completely:** only allowed when the person has no shares in the group. Otherwise use `left`.
- **Leaving voluntarily:** a member may leave once their balance is 0. In one database transaction their status becomes `left`, their role `viewer` and `leftOn` today if empty; then their team membership is removed. Their history stays. Coming back after leaving voluntarily isn't supported in v1.

## Function-side checks

Every HTTP request runs step 1 once, in `createHandler`. Every route that changes data then runs steps 2–5 (helper `requireMember()` in `packages/server`):

1. Verify the caller: call Appwrite's `account.get()` with the JWT from the `x-appwrite-user-jwt` header, on a separate node-appwrite client with the function's endpoint and project, `setJWT` and no API key. Pass the header exactly as received; never split or trim it. The returned user's `$id` is the caller. If the JWT is missing, or Appwrite rejects it, return `UNAUTHENTICATED`. Never trust `x-appwrite-user-id` (see [Function execute permissions](#function-execute-permissions)).
2. Load the caller's person (`persons.userId = caller`).
3. Load their `members` row for the target group. If it is missing or `status = placeholder`, return `NOT_A_MEMBER`.
4. Check the role against the table above. If it fails, return `FORBIDDEN`.
5. If the group is archived, return `ARCHIVED`.

Routes that don't act as a joined member of an existing group skip steps 2–5, never step 1: `groups POST /groups`, `identity GET /groups/pending` and `POST /groups/{id}/join` (join needs the caller's own member row instead), and the other identity routes except `POST /invites`, which checks the role as in step 4.

Scheduled jobs run with the server key and no caller. They write as the system and record `actorPersonId = null` in `activity`. A run is a scheduled job only when `x-appwrite-trigger` is exactly `schedule` (`ctx.scheduled` in `createHandler`). A missing JWT never makes a request a scheduled job; on any other request it means `UNAUTHENTICATED`, except on a route declared public. Only `/health` is public, and it returns nothing about the caller or the project. (A forged `X-Appwrite-Trigger: schedule` arrives merged as `schedule, http`, so the exact match fails closed.)

## Storage

- `receipts`: any signed-in user can upload. The client must set `read("team:<groupId>")` on the file. The `ledger` function checks, before attaching a file to a transaction, that the file's permissions match that transaction's group, then resets them to exactly `read("team:<groupId>")`. That removes any `update` or `delete` the uploader granted themselves, so nobody can swap or delete a receipt behind a locked transaction.
- `statements`: only the `statements` function writes. Files are readable by the group's team.

## Function execute permissions

| Function | Execute |
| --- | --- |
| `ledger`, `groups`, `identity` | `users` (any signed-in user; the function checks the rest) |
| `scheduler`, `statements` | `users` for their HTTP routes; cron runs need no execute permission |

Execute is `users` only, never `any` or `guests`, and no function gets a custom domain. Appwrite serves a function's domains (the generated `*.appwrite.run` one and any custom one) only when execute includes `any` or `guests`, so the only way in is `createExecution` by a signed-in user. No user is ever made an impersonator, because Appwrite's impersonation headers would let them execute as someone else.

**Why functions verify the JWT.** Appwrite refuses execution headers that start with `x-appwrite` only when they are lower-case. On `ledgerly-dev` (2026-10-18), a client sent `X-Appwrite-User-Id` and `X-Appwrite-User-Jwt` with made-up values in an execution's `headers`, and the function received them. For an anonymous caller (the test function had execute `any`) `x-appwrite-user-id` was the forged value. For a signed-in caller it was `"<forged>, <real>"`. `account.get()` accepts a JWT only if Appwrite signed it, it hasn't expired and its session still exists, so a made-up or merged value fails.
