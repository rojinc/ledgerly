# Data model

Every table, column and index. **This page is the contract.** The Appwrite schema files in `appwrite/` must match it exactly. Change this page first, in a `contract` PR, then the schema. See [Multi-agent workflow → Contract changes](../collaboration/multi-agent-workflow.md#contract-changes).

## Conventions

- One Appwrite TablesDB database, ID `main`.
- Table IDs are lowercase plural nouns. Column names are camelCase.
- **IDs:** Appwrite IDs (up to 36 chars: `a-z A-Z 0-9 . - _`, not starting with a special character). User-created rows get their ID from the client (`ID.unique()`), so retries are safe. Generated rows use deterministic IDs ([Scheduling](scheduling.md#idempotency)).
- **References** are plain `varchar(36)` ID columns, never Appwrite relationship columns ([D-006](decisions.md)).
- **Money:** `integer` cents. Column names end in `Cents`.
- **Local dates:** `varchar(10)` holding `YYYY-MM-DD` in the group's timezone. Text comparison sorts them correctly, so range queries work.
- **Instants:** `datetime` (UTC). Names end in `At`.
- **JSON:** stored as `text` (or `mediumtext` when large) and validated by zod schemas in `packages/core` on every read and write. Never put a value in JSON if we need to filter or sort by it; that value gets its own column.
- **No duplicated facts.** The only deliberate copies are the ones listed in [Derived and copied data](#derived-and-copied-data).
- **Row security** is on for every table. Clients get *read* permission only, never write ([D-003](decisions.md)).

Notation: `enum(a, b)` means a `string` column with enum format. `?` means optional (nullable). `[]` means an array column.

A column with a default is created with `required: false` in `appwrite/`, because Appwrite can't combine `required` with a default. Appwrite writes the default when no value is given, so these columns are never empty, and the generated row types show them as non-null.

## Tables at a glance

```
persons ──┬── identities                       (server only)
          ├── profiles        (1:1 with a user)
          └── members ── groups ── schedules
                           │
                      transactions ──┬── shares
                           │         ├── items
                           │         └── receiptFiles  (server only)
                      statements
                      activity
                      invites                   (server only)
                      reminders                 (server only)
                      balances      (1:1 with a group, server only)
                      checkpoints               (server only)
```

## persons

One row per real person or business we track, registered or not. Row IDs are 20 random characters from `a-z0-9`, made by a secure random generator, not `ID.unique()`: its hex timestamp would show group members when a person was first seen ([D-016](decisions.md)).

| Column | Type | Notes |
| --- | --- | --- |
| `userId` | varchar(36)? | Appwrite user ID. Empty = placeholder. |
| `displayName` | varchar(100) | Their own name if registered; otherwise the name used by whoever first added them. |
| `claimedAt` | datetime? | When the person first got a user account (bootstrap or adopt). Claim joins member rows whose `$createdAt` is strictly before it ([identity](identity-and-invites.md#claim-linking-records-to-a-new-account)). |
| `mergedInto` | varchar(36)? | Set when this person is merged into another ([identity](identity-and-invites.md#merging-two-persons)). Kept for good: old statements and groups the other person left on their own can still name this one. |
| `mergeGroupIds` | varchar(36)[]? | The groups P had member rows in when it was marked as merged, written once in that step and never changed: the only groups a merge looks in for P's shares, inputs and templates ([identity](identity-and-invites.md#merging-two-persons)). `null` for anyone never merged. Written only by `identity`. |
| `mergeMembersJson` | mediumtext? | `MergeMembers`: for each of P's groups, P's member `joinedOn` and `leftOn` there, and U's if U had a row there (else `null`), as P was marked as merged. `mediumtext`, since P's groups have no cap. Written once with `mergeGroupIds` and never changed; step 3 plans a posted row's items with them, and a group whose dates can't be read is left for later ([identity](identity-and-invites.md#merging-two-persons)). `null` for anyone never merged. Written only by `identity`. |
| `mergeCursorsJson` | mediumtext? | `MergeCursors`: for each of P's groups whose inputs merge step 3 has started scanning, the `$id` of the last transaction scanned there (`after`) and the IDs of the transactions left as they are behind it (`left`), so a later run carries on from there (a lead decision, #242 G). Written by step 3 after each page, never before step 1. `null` until then, and for anyone never merged. Written only by `identity`. |
| `deletedAt` | datetime? | Account deleted; the person is kept anonymised for others' history ([deleting an account](identity-and-invites.md#deleting-an-account-m4)). Set first, as the point of no return; a person with `deletedAt` and `userId` both set has a deletion still to finish. |
| `rev` | varchar(20)? | A fresh random value on every guard write, so the write is always a real change ([ledger concurrency](ledger.md#concurrency)). The person row is a guard for invite and reminder limits, for adds that find the person, for a merge's writes on the person it merges into, and for a purge deleting a placeholder's member rows. |

Indexes: `idx_userId (userId)`, `idx_mergedInto (mergedInto)`, `idx_deletedAt (deletedAt)` (the hourly job finds deletions to finish).
Permissions: placeholders have none (server only). A registered person's row gets `read("user:<userId>")`.

## identities

Email addresses and phone numbers. This is how we recognise people.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | varchar(330) | `email:<lowercased>` or `phone:<E.164>`, e.g. `phone:+61412345678` |
| `type` | enum(email, phone) | |
| `personId` | varchar(36) | |
| `verified` | boolean | default `false`. `true` only after the user proves ownership in Appwrite Auth. |
| `verifiedAt` | datetime? | |

Indexes: `uniq_key (key)` **unique**, `idx_personId (personId)`.
Permissions: none (server only). Keeping the key in its own table means one person can have several emails and phones, and the unique index never sees empty values.

## profiles

Row ID = the Appwrite user ID. One per user.

| Column | Type | Notes |
| --- | --- | --- |
| `personId` | varchar(36) | |
| `timezone` | varchar(64) | IANA name, e.g. `Australia/Sydney` |
| `region` | varchar(16) | Holiday region, e.g. `AU-NSW` |
| `currency` | varchar(3) | ISO 4217, default `AUD` |
| `businessJson` | text? | `BusinessDetails` (below) |
| `invoicePrefix` | varchar(16) | default `INV-` |
| `lastInvoiceNumber` | integer | default 0. Only the `statements` function changes it, in the same transaction that numbers the invoice ([finalize step 2](statements.md#2-finalize-post-statementsidfinalize)). |
| `summaryFrequency` | enum(none, weekly, fortnightly, monthly) | default `none` |
| `nextSummaryAt` | datetime? | Set by `identity` when `summaryFrequency` or `timezone` changes (empty for `none`), then moved forward by the scheduler ([step 4](scheduling.md#step-4-summary-emails)) |
| `hoursCapMinutes` | integer? | The user's own work-hours limit (F-82): 60 to 10080 for a week, 60 to 20160 for a fortnight. All three `hoursCap*` columns are set together, or all empty for no limit. |
| `hoursCapPeriod` | enum(week, fortnight)? | A week runs Monday to Sunday in the profile's `timezone` |
| `hoursCapStartsOn` | varchar(10)? | A fortnight's first Monday (YYYY-MM-DD); fortnights count from it, before and after. Empty for a week. |

Indexes: `idx_nextSummaryAt (nextSummaryAt)`.
Permissions: `read("user:<userId>")`. Writes go through `identity PATCH /profile`, except `lastInvoiceNumber` (`statements`) and `nextSummaryAt` (also `scheduler`). `account` deletes it with the account.

```ts
type BusinessDetails = {
  businessName?: string
  abn?: string             // stored as digits only
  address?: string
  email?: string
  phone?: string
  bank?: { accountName: string; bsb: string; accountNumber: string }
  payId?: string
  invoiceNotes?: string    // printed at the bottom of invoices
}
```

## groups

Row ID = Appwrite Team ID ([D-004](decisions.md)).

| Column | Type | Notes |
| --- | --- | --- |
| `type` | enum(personal, house, employer, pair) | Never changes |
| `name` | varchar(100) | |
| `ownerPersonId` | varchar(36) | Creator. In employer groups, the worker who issues invoices. |
| `currency` | varchar(3) | Never changes once there are transactions |
| `timezone` | varchar(64) | |
| `region` | varchar(16) | For public holidays |
| `statementCycle` | enum(none, weekly, fortnightly, monthly) | default `none` (employer default `monthly`) |
| `cycleAnchor` | varchar(10)? | First day of the first period, for weekly and fortnightly cycles |
| `nextCloseAt` | datetime? | When the current period's statement is due to be drafted ([statements](statements.md#periods)). Set by `groups` on create and whenever `statementCycle`, `cycleAnchor` or `timezone` changes; moved forward by `statements`. |
| `nextCheckAt` | datetime? | When the group's [nightly check](scheduling.md#step-6-nightly-check) is next due. Written only by `scheduler`. Empty means due now, so a group's first check is also the backfill of its `balances` row. |
| `settingsJson` | text | `GroupSettings` (below) |
| `archivedAt` | datetime? | Archived groups are read-only |
| `rev` | varchar(20)? | A fresh random value on every guard write, so the write is always a real change ([ledger concurrency](ledger.md#concurrency)) |

Indexes: `idx_nextCloseAt (nextCloseAt)`, `idx_nextCheckAt (nextCheckAt)`, `idx_owner_type (ownerPersonId, type)` (bootstrap finds the caller's personal group on every login).
Permissions: `read("team:<groupId>")`.

```ts
type GroupSettings =
  | { type: 'employer'; defaultRateCents: number; paymentTermsDays: number; autoFinalize: boolean;
      recipients: string[] /* billing emails */ }   // auto-posting is per schedule (schedules.autoPost)
  | { type: 'house'; autoFinalize: boolean; defaultBillSplit: 'days' | 'equal' }
  | { type: 'personal' }
  | { type: 'pair' }
```

Defaults when `POST /groups` gives no `settings`: employer `{ defaultRateCents: 0, paymentTermsDays: 14, autoFinalize: false, recipients: [] }`, house `{ autoFinalize: false, defaultBillSplit: 'days' }`.

## members

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `personId` | varchar(36) | |
| `displayName` | varchar(100) | What this group calls the person |
| `role` | enum(admin, member, viewer) | Authority inside the group ([permissions](permissions.md)) |
| `status` | enum(placeholder, active, left) | `placeholder`: hasn't joined this group, with or without an account. `active`: joined. `left`: joined, then moved out. A member who moves out before joining stays `placeholder` ([D-016](decisions.md)). Written only by the `groups`, `identity` and `account` functions. |
| `joinedOn` | varchar(10) | Local date. The `groups` function sets it to the day they were added unless the caller gives one (not a database default). |
| `leftOn` | varchar(10)? | Local date |
| `rev` | varchar(20)? | A fresh random value on every guard write, so the write is always a real change ([ledger concurrency](ledger.md#concurrency)) |

Indexes: `uniq_group_person (groupId, personId)` **unique**, `idx_person_status (personId, status)`, `idx_groupId (groupId)`.
Permissions: `read("team:<groupId>")`.

## transactions

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `kind` | enum(shift, expense, bill, payment, loan, income, adjustment) | Never changes after creation |
| `status` | enum(scheduled, running, due, posted, void) | [Statuses](ledger.md#statuses) |
| `date` | varchar(10) | Local date of the event (shift day, purchase day, day a bill was paid) |
| `description` | varchar(200) | |
| `category` | varchar(32)? | One of the categories in `packages/core` |
| `totalCents` | integer | Negative only for refunds (expense, bill) and adjustments ([ledger](ledger.md#invariants)) |
| `inputJson` | text | The parts of the user's input that have no column of their own: `payers`, `split`, `shift`, `bill` (period only; its status and `dueOn` live in the `status` and `dueOn` columns), `payment`, `adjustment`, `note`. Types in [Functions API](functions-api.md#transactioninput). |
| `dueOn` | varchar(10)? | Bills only |
| `scheduleId` | varchar(36)? | Set on occurrences created by a schedule |
| `overridden` | boolean | default `false`. The user edited this occurrence. |
| `statementId` | varchar(36)? | Set when a final statement locks it |
| `receiptFileIds` | varchar(36)[]? | Files in the `receipts` bucket. Each one has a [`receiptFiles`](#receiptfiles) row. |
| `startedAt` | datetime? | Timer shifts |
| `remindedAt` | datetime? | When the last reminder (bill due, shift to confirm, long-running timer) was sent, or was settled without an email (nobody to send to, an archived group, an address Resend refuses; but a shift of a schedule that auto-posts isn't settled with nobody to send to). Cleared when a bill's `dueOn` or a `scheduled` row's `date` changes |
| `voidReason` | varchar(200)? | |
| `createdBy` | varchar(36) | personId. Schedule occurrences use the schedule's `createdBy`. |
| `updatedBy` | varchar(36) | personId |

Indexes:

| Name | Columns | Used by |
| --- | --- | --- |
| `idx_group_date` | groupId, date | calendar, history |
| `idx_group_status_date` | groupId, status, date | due bills |
| `idx_group_statement_date` | groupId, statementId, date | statements sweep (unlocked rows have `statementId` null), so it doesn't read locked history |
| `idx_schedule_date` | scheduleId, date | schedule edits |
| `idx_statementId` | statementId | statement detail, void |
| `idx_status_date` | status, date | scheduler auto-post |
| `idx_status_dueOn` | status, dueOn | bill reminders |

Permissions: `read("team:<groupId>")`.

## shares

Only posted transactions have shares ([I-6](ledger.md#invariants)).

| Column | Type | Notes |
| --- | --- | --- |
| `transactionId` | varchar(36) | |
| `personId` | varchar(36) | |
| `givenCents` | integer | |
| `receivedCents` | integer | |
| `groupId` | varchar(36) | copied from the transaction |
| `date` | varchar(10) | copied |
| `kind` | varchar(16) | copied |
| `category` | varchar(32)? | copied |

Indexes: `idx_transactionId (transactionId)`, `idx_group_person_date (groupId, personId, date)`, `idx_person_date (personId, date)`.
Permissions: `read("team:<groupId>")`.

## items

| Column | Type | Notes |
| --- | --- | --- |
| `transactionId` | varchar(36) | |
| `position` | integer | 0-based order on the receipt |
| `name` | varchar(120) | |
| `quantity` | double | default 1. For display only; amounts never use it. |
| `amountCents` | integer | Line total; may be negative (discount) |
| `category` | varchar(32)? | |
| `splitJson` | text | `SplitSpec` |

Items are rebuilt completely on every edit, like shares ([building shares](ledger.md#building-shares)): rows are rewritten whole, and new ones get `ID.unique()` IDs.
Indexes: `idx_transaction_position (transactionId, position)`.
Permissions: `read("team:<groupId>")` (the function sets the group's team when it writes).

## balances

A cache of each person's balance in a group, so `GET /groups/{groupId}/balances` reads one row instead of every share ([ledger](ledger.md#balances)). One row per group: row ID = `groupId`.

| Column | Type | Notes |
| --- | --- | --- |
| `peopleJson` | mediumtext | `BalancesPeople`: `{ personId, netCents, shares }[]`, one entry for each person with at least one share in the group, with their net and how many shares they have, in ascending `personId` order |

A group with no row has none built yet, or had it deleted (by a [merge](identity-and-invites.md#merging-two-persons), or because it didn't fit, [ledger](ledger.md#balances)): `/balances` sums its shares instead, and the [nightly check](scheduling.md#step-6-nightly-check) builds the row. Why it isn't one row per person: [Scaling](scaling.md#the-balances-cache).
Indexes: none (read by ID).
Permissions: none (server only). Clients get balances from `GET /groups/{groupId}/balances`.

## receiptFiles

Which transactions list each file in the `receipts` bucket, so the scheduler can delete the files no transaction lists ([scheduler step 5](scheduling.md#step-5-receipt-clean-up)). The row ID is the file ID.

| Column | Type | Notes |
| --- | --- | --- |
| `transactionIds` | varchar(36)[]? | The transactions that list the file now. Empty or `null` means none. |
| `detachedAt` | datetime? | When the last transaction stopped listing the file; empty while one lists it. On a row the scheduler made for a never-attached file, the file's `$createdAt`. |
| `deletingAt` | datetime? | Set by the scheduler, in a database transaction, before it deletes the file. From then on an attach is refused ([permissions](permissions.md#storage)). |

- **The ledger** writes the row of every file it adds to or takes off a transaction's `receiptFileIds`, in the same database transaction as the list ([concurrency](ledger.md#concurrency)), on every path that attaches or takes off a file (a new path must too):
  - **adding a file:** it creates the row, or adds the transaction ID and clears `detachedAt`;
  - **taking a file off:** it drops the transaction ID, and sets `detachedAt` once none is left. A file with no row (attached before these rows existed) gets one, with no transaction listed.
- **Void** keeps a transaction's `receiptFileIds`, so its files stay listed.
- **Deleting a transaction row:** code that deletes one that lists receipts takes them off in the same database transaction. Three places do, two of them through the shared `removeOccurrences` (`packages/server/src/scheduler/end-schedule.ts`): `DELETE /schedules/{id}`, which deletes a schedule's edited and voided occurrences too ([schedule routes](scheduling.md#schedule-routes)); an account deletion's keep, which deletes their schedules that haven't started the same way; and the purge when an account is deleted ([deleting an account](identity-and-invites.md#each-group-they-joined)). Their batches of at most 90 writes count up to 10 receipt rows for each transaction.
- **Every writer of a row,** the ledger and those above included, stages its write and then reads the row again as committed (not through its transaction), and runs again if it changed. A group guard isn't enough on its own, because two attaches in two groups at once can list one file in both ([#43](https://github.com/rojinc/ledgerly/issues/43)'s accepted race). In one database transaction a file gets at most one row write, however many of its transactions that transaction changes or deletes.
- **The scheduler** sets `deletingAt`, makes the row for a file that was never attached, deletes the file, and deletes the row once its `deletingAt` is at least an hour old. Until then the row refuses any attach of that ID, including one that read the rows before the scheduler made this one.
- **Backfill:** `scripts/backfill-receipt-files.mjs` is for files uploaded before the ledger wrote these rows. The lead runs it once in each environment, from `main`, after the ledger change is deployed there and a minute has passed (no execution of the old ledger, which times out after 15 s, can still be attaching files without rows), with a one-off key (`rows.read`, `rows.write`, `files.read`) deleted afterwards. In order:
  1. **Listed files:** one full pass over `transactions` where `receiptFileIds` isn't null, paged by `$id` (a one-off, so no index). That query also matches `[]` (checked on `ledgerly-dev`), so only a non-empty list counts. For each file, on every attempt, it reads the file's row, then reads the transactions the pass found for it again, as committed, and adds those that still list the file to its row, creating the row if needed and clearing `detachedAt`. It stages that write, then reads the row and those transactions again as committed; on a change or a 409 it starts the file again, and it never skips one. It also stages a [guard write](ledger.md#concurrency) (a fresh `rev`) on the group row of each transaction it adds: every write that takes a file off a transaction guards that group too, so one landing meanwhile fails one of the two commits, even when it leaves the file's row as it was. A transaction that dropped the file since the pass is never added, so a receipt taken off meanwhile is still deleted. When none of them still lists the file, it writes nothing (the sweep then sees the file's row, or gives it one). A row already marked `deletingAt` is left alone and reported, and the script exits non-zero: step 5 is deleting a file a transaction lists.
  2. **The sweep:** every file in the bucket that still has no row gets one with `detachedAt = now`, so step 5 deletes it a day later. These are uploads that were never attached, files taken off before the rows existed, and listed files whose transactions all dropped them before step 1 got to them. It only creates rows; a 409 means the ledger attached the file first, and the file is skipped.
  3. **Last,** the [`checkpoints`](#checkpoints) row `receipt-clean-up`, with `through` = when the script started: every file created by then is in the sweep's listing. Step 5 does nothing until it exists.

  Neither pass ever upserts a `receiptFiles` row. The script is safe to run again.
- **Undoing the ledger's row writes** (reverting that change on `main`) needs step 5 stopped first: revert step 5 first, or delete the `checkpoints/receipt-clean-up` row. Otherwise step 5 would take a file attached after the revert for one never attached, and delete it.

Indexes: `idx_detachedAt (detachedAt)`.
Permissions: none (server only).

## checkpoints

How far a background job has got, for a job that must not lose its place from one run to the next. One row per job; the row ID names it.

| Column | Type | Notes |
| --- | --- | --- |
| `through` | datetime | The job has dealt with everything up to this time |

- `receipt-clean-up`: made by the [backfill](#receiptfiles) as its last write, then moved forward by [step 5](scheduling.md#step-5-receipt-clean-up)'s pass 1. Step 5 reads it once per run, and does nothing until it exists. Step 5 only ever updates it, never creates it, so deleting it stops even a run already in progress from writing it again.

Permissions: none (server only).

## schedules

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `kind` | enum(shift, bill, expense, income) | |
| `description` | varchar(200) | |
| `templateJson` | text | `ScheduleInput.template`: a `TransactionInput` without `id`, `groupId`, `date`, `kind` and `description` (those live on the schedule), and without `receiptFileIds` (a receipt belongs to one transaction); a bill's is `due`, with no `dueOn`, billing period or `days` split |
| `rrule` | varchar(255) | RFC 5545 rule, e.g. `FREQ=WEEKLY;BYDAY=TH` |
| `startsOn` | varchar(10) | First possible occurrence (local date) |
| `endsOn` | varchar(10)? | Last possible occurrence. Empty = until stopped. |
| `exdates` | varchar(10)[]? | Dates to skip |
| `skipPublicHolidays` | boolean | Uses the group's `region` |
| `autoPost` | boolean | Shifts: post after the day ends. Bills: post on the due date (autopay). |
| `horizonDays` | integer | default 56 |
| `generatedThrough` | varchar(10)? | Last local date already expanded |
| `nextRunAt` | datetime? | When the scheduler should next look at it. Empty = finished. |
| `createdBy` | varchar(36) | personId |

Indexes: `idx_nextRunAt (nextRunAt)`, `idx_groupId (groupId)`.
Permissions: `read("team:<groupId>")`.

## statements

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `type` | enum(invoice, divide) | `invoice` for employer groups, `divide` for houses |
| `periodStart` | varchar(10) | |
| `periodEnd` | varchar(10) | |
| `status` | enum(draft, finalizing, final, void) | `finalizing` means a finalize was interrupted and is safe to resume |
| `number` | integer? | Invoices only |
| `displayNumber` | varchar(32)? | e.g. `INV-0010`, with the prefix copied at finalize time |
| `issuedOn` | varchar(10)? | |
| `dueOn` | varchar(10)? | |
| `snapshotJson` | mediumtext | `StatementSnapshot` ([statements](statements.md#snapshot)) |
| `pdfFileId` | varchar(36)? | In the `statements` bucket |
| `sentAt` | datetime? | |
| `finalizedBy` | varchar(36)? | personId |

Indexes: `idx_group_period (groupId, periodStart)`, `idx_status (status)`.
Permissions: `read("team:<groupId>")`.

## activity

Append-only. Never updated, but for one column: a [merge](identity-and-invites.md#merging-two-persons) moves `subjectPersonId` from the placeholder to the person it was merged into (`idx_group_subject`). Deleted only with a group purged when a member deletes their account and nobody else is in its team ([deleting an account](identity-and-invites.md#deleting-an-account-m4)).

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `actorPersonId` | varchar(36)? | Empty for system jobs |
| `action` | varchar(48) | e.g. `transaction.created`, `member.added`, `statement.finalized`, `reminder.sent` |
| `transactionId` | varchar(36)? | |
| `subjectPersonId` | varchar(36)? | The person a `member.*` or `reminder.sent` row is about, so the app shows their current name ("Former member" after deletion) |
| `summary` | varchar(255) | Human-readable, e.g. `Changed “Electricity”: $90.00 → $95.00`. Never holds a display name: a member or reminder row names its person through `subjectPersonId` instead, and a group row names no one (rows written before #50 keep their text). |
| `changesJson` | text? | `{ before, after }` of the changed fields; never a display name. Empty when only a name changed, which the summary says. |
| `at` | datetime | |

Indexes: `idx_group_at (groupId, at)`, `idx_group_subject (groupId, subjectPersonId)` (a merge finds the rows about P).
Permissions: `read("team:<groupId>")`.

## invites

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `memberId` | varchar(36) | |
| `identityKey` | varchar(330) | Where it was sent |
| `tokenHash` | varchar(64) | SHA-256 hex of the token. The token itself is never stored. |
| `channel` | enum(email, sms) | |
| `invitedBy` | varchar(36) | personId |
| `sentAt` | datetime | |
| `expiresAt` | datetime | `sentAt` + 14 days |
| `acceptedAt` | datetime? | |

Indexes: `uniq_tokenHash (tokenHash)` **unique**, `idx_invitedBy_sentAt (invitedBy, sentAt)`, `idx_identity_sentAt (identityKey, sentAt)`.
Permissions: none (server only).

## reminders

One row per reminder sent ([reminders](identity-and-invites.md#reminders), F-63): the state its rate limits count. Row ID = the client's `id`, so a retry finds it.

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | A `pair` group |
| `sentBy` | varchar(36) | personId of the sender, a joined member |
| `toPersonId` | varchar(36) | personId of the other member it was sent to |
| `channel` | enum(email, sms) | `email` until SMS reminders, after [#40](https://github.com/rojinc/ledgerly/issues/40) |
| `sentAt` | datetime | |

The address typed and the amount are **not stored**: the limits count by person, and the address is already an identity row.
Indexes: `idx_sentBy_sentAt (sentBy, sentAt)`, `idx_toPerson_sentAt (toPersonId, sentAt)`, `idx_groupId (groupId)` (for a purge).
Permissions: none (server only). Kept until either person's account is deleted, or the group is purged ([deleting an account](identity-and-invites.md#deleting-an-account-m4)); pruning old rows is a later follow-up.

## Storage buckets

| Bucket | Who uploads | File permissions | Limits |
| --- | --- | --- | --- |
| `receipts` | Clients, directly | Client sets `read("team:<groupId>")` at upload. Appwrite only lets a user grant roles they hold. The ledger resets it to exactly that when the file is attached ([permissions](permissions.md#storage)). | 10 MB; jpg, jpeg, png, webp, heic, pdf |
| `statements` | `statements` function | `read("team:<groupId>")` | 10 MB; PDFs only |

Bucket-level permission on `receipts`: `create("users/verified")`, so only verified users can upload. File security on for both buckets.

## Derived and copied data

Each item below is written only by the functions listed and can be rebuilt from its source. Nothing else is copied.

| Data | Source | Written by |
| --- | --- | --- |
| `shares` rows | `transactions.inputJson` + `items` + members | `ledger` (and `scheduler` when it auto-posts, through the same core function) |
| `shares.groupId/date/kind/category` | the transaction | rebuilt with the shares |
| `statements.snapshotJson`, PDFs | transactions and shares at finalize time | `statements` (an intentional historical snapshot) |
| `balances` rows | shares | every writer of shares, inside the same transaction ([ledger](ledger.md#balances)); created and repaired by the scheduler's [nightly check](scheduling.md#step-6-nightly-check) |
| `receiptFiles.transactionIds` | `transactions.receiptFileIds` | every writer of a receipt list or a transaction row that lists receipts, inside the same transaction as the list change or the row delete: `ledger`, `scheduler` (`DELETE /schedules/{id}`) and `account` (the keep's schedule deletes, and the purge). The backfill script rebuilds them. `detachedAt`, `deletingAt` and the rows of never-attached files are the scheduler's clean-up state, not a copy. |

## Categories

Defined once in `packages/core` (`CATEGORIES`): `rent`, `electricity`, `gas`, `water`, `internet`, `phone`, `groceries`, `household`, `food`, `transport`, `entertainment`, `health`, `work`, `subscriptions`, `other`.
