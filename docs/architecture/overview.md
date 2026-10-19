# System overview

## The big picture

```
 Web app (React + Vite PWA)            Mobile app, later (Expo / React Native)
        │                                          │
        │ reads: Appwrite SDK + Realtime           │
        │ writes: function executions only         │
        └────────────────────┬─────────────────────┘
                             ▼
┌─────────────────────────── Appwrite Cloud ───────────────────────────┐
│ Auth        users, sessions, email/phone verification                 │
│ TablesDB    persons, identities, profiles, groups, members,           │
│             transactions, shares, items, schedules, statements,       │
│             activity, invites                                         │
│ Teams       one team per group, which gives members read access       │
│ Storage     receipts, statements (PDFs)                               │
│ Realtime    live updates to rows the user can read                    │
│ Functions   ledger      all money writes                              │
│             groups      groups, members, settings                     │
│             identity    bootstrap, profile, claim, merge, invites,    │
│                         join                                          │
│             scheduler   cron: schedules, auto-post, reminders,        │
│                         summaries, nightly check                      │
│             statements  cron + HTTP: invoices, monthly divides, PDFs  │
└───────────────────────────────────────────────────────────────────────┘
        │                                 │
   Resend (email)                  SMS provider (invites, later)
```

## The five ideas everything rests on

1. **One ledger.** Every module is a group of people with transactions. Each posted transaction has **shares** saying what each person gave and received. Every balance, invoice and report is a sum of shares. → [The ledger](ledger.md)
2. **Clients read directly but never write to the database.** Reads go straight to Appwrite, which is fast and works with Realtime. Every write goes through a function that validates it and writes all of its rows in one database transaction. → [Functions API](functions-api.md)
3. **One Appwrite Team per group.** Rows carry `read("team:<groupId>")`. Joining or leaving a group changes one membership, never thousands of rows. → [Permissions](permissions.md)
4. **People don't need accounts.** A *person* can be a placeholder known only by email or phone. When they sign up and verify, their records link to them automatically. → [People, identity and invites](identity-and-invites.md)
5. **History doesn't change.** Final statements lock their transactions. Fixes are new adjustment transactions. → [Statements](statements.md)

## Read path

1. The web app signs in with the Appwrite Web SDK.
2. It lists the user's groups (their teams), then queries the rows it needs, for example `transactions` where `groupId = X` and `date` falls in October.
3. Appwrite only returns rows whose permissions include the user's teams.
4. The app subscribes to Realtime channels for those tables and refetches when something changes.

## Write path

1. The app builds a payload. User-created rows get a client-generated ID, which makes retries safe.
2. It calls a function synchronously (`functions.createExecution`) with a path and method, for example `POST /transactions`.
3. The function:
   1. verifies the caller with `account.get()` using the JWT in the `x-appwrite-user-jwt` header (never `x-appwrite-user-id`; see [Permissions](permissions.md#function-side-checks)),
   2. validates the payload with the shared zod schema from `packages/core`,
   3. checks membership and role in `members`,
   4. builds the rows with pure functions from `packages/core`,
   5. writes them in **one Appwrite TablesDB transaction** (all or nothing),
   6. returns `{ ok: true, data }`.
4. Realtime notifies every member's app.

## Background jobs

| Job | Trigger | What it does |
| --- | --- | --- |
| `scheduler` | cron, hourly | Creates occurrences for due schedules, auto-posts past shifts and autopay bills, sends reminders and summary emails, and runs the nightly check (balances row, ledger invariants, team memberships) |
| `statements` | cron, hourly | Drafts statements for periods that ended, and auto-finalizes where enabled |
| `identity` | cron, hourly | Carries on person merges a claim left unfinished ([finishing merges](identity-and-invites.md#finishing-merges)) |

All jobs are **idempotent**: running them twice does no harm. They use deterministic row IDs and conflict-checked transactions. → [Scheduling](scheduling.md)

## Code layout

```
apps/web            React app
packages/core       pure TypeScript domain logic, shared everywhere
packages/server     helpers for functions (Appwrite client, permissions, email)
functions/*         one folder per Appwrite Function, bundled with esbuild
appwrite/           tables, buckets and functions as code (Appwrite CLI)
docs/               these docs (synced to GitBook)
```

Details: [Repository structure](../engineering/repo-structure.md).

## Where to go next

- Changing money logic → [The ledger](ledger.md)
- Adding a table or column → [Data model](data-model.md)
- Adding an endpoint → [Functions API](functions-api.md)
- Why something is the way it is → [Decision log](decisions.md)
