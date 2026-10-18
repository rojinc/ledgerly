# Permissions

There are two layers:

1. **Appwrite permissions decide who can *read*.** Every group is an Appwrite Team, and its rows carry `read("team:<groupId>")`.
2. **Functions decide who can *write*.** Clients have no write permission on any table. Each function checks the caller's `members` row (role and status) before it changes anything.

Keeping authority in one place (`members.role`) means there is one source of truth. Appwrite team roles are **not** used for authorization. ([D-004](decisions.md))

## Teams

- Team ID = group row ID. Created by the `groups` function with the server API key when the group is created.
- A person is a team member only if they have a user account (`persons.userId`). Placeholders are in `members` but not in the team.
- Team memberships are created, changed and deleted **only by functions**, with the server key. Clients never call the Teams API to change membership.
- When a placeholder is claimed, the `identity` function adds the new user to the team of every group they are a member of.

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

### Default roles by group type

| Group type | Creator | Others |
| --- | --- | --- |
| `personal` | admin (only member) | none allowed |
| `employer` | admin (the worker) | counterpart (employer) = viewer |
| `house` | admin | member |
| `pair` | admin | counterpart = admin |

### Leaving a group

- **Moving out (house):** set `leftOn` and status `left`, and change the role to `viewer`. They keep read access so they can see and settle what they owe.
- **Removing completely:** only allowed when the person has no shares in the group. Otherwise use `left`.
- **Leaving voluntarily:** a member may leave once their balance is 0. Their team membership is removed; their history stays.

## Function-side checks

Every function route that changes data starts with the same steps (helper `requireMember()` in `packages/server`):

1. Read the caller's user ID from the `x-appwrite-user-id` header. If it is missing, return `UNAUTHENTICATED`.
2. Load the caller's person (`persons.userId = caller`).
3. Load their `members` row for the target group. If it is missing or `status = placeholder`, return `NOT_A_MEMBER`.
4. Check the role against the table above. If it fails, return `FORBIDDEN`.
5. If the group is archived, return `ARCHIVED`.

Scheduled jobs run with the server key and no caller. They write as the system and record `actorPersonId = null` in `activity`.

## Storage

- `receipts`: any signed-in user can upload. The client must set `read("team:<groupId>")` on the file. The `ledger` function checks, before attaching a file to a transaction, that the file's permissions match that transaction's group, then resets them to exactly `read("team:<groupId>")`. That removes any `update` or `delete` the uploader granted themselves, so nobody can swap or delete a receipt behind a locked transaction.
- `statements`: only the `statements` function writes. Files are readable by the group's team.

## Function execute permissions

| Function | Execute |
| --- | --- |
| `ledger`, `groups`, `identity` | `users` (any signed-in user; the function checks the rest) |
| `scheduler`, `statements` | `users` for their HTTP routes; cron runs need no execute permission |
