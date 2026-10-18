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
                           │         └── items
                      statements
                      activity
                      invites                   (server only)
```

## persons

One row per real person or business we track, registered or not. Row IDs are 20 random characters from `a-z0-9`, made by a secure random generator, not `ID.unique()`: its hex timestamp would show group members when a person was first seen ([D-016](decisions.md)).

| Column | Type | Notes |
| --- | --- | --- |
| `userId` | varchar(36)? | Appwrite user ID. Empty = placeholder. |
| `displayName` | varchar(100) | Their own name if registered; otherwise the name used by whoever first added them. |
| `claimedAt` | datetime? | When the person first got a user account (bootstrap or adopt). Claim joins member rows whose `$createdAt` is strictly before it ([identity](identity-and-invites.md#claim-linking-records-to-a-new-account)). |
| `mergedInto` | varchar(36)? | Set while this person is being merged into another ([identity](identity-and-invites.md#merging-two-persons)). |
| `deletedAt` | datetime? | Account deleted; the person is kept anonymised for others' history. |

Indexes: `idx_userId (userId)`, `idx_mergedInto (mergedInto)`.
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
| `lastInvoiceNumber` | integer | default 0. Only the `statements` function changes it, with an atomic increment. |
| `summaryFrequency` | enum(none, weekly, fortnightly, monthly) | default `none` |
| `nextSummaryAt` | datetime? | Set by `identity` when `summaryFrequency` or `timezone` changes (empty for `none`), then moved forward by the scheduler ([step 4](scheduling.md#step-4-summary-emails)) |

Indexes: `idx_nextSummaryAt (nextSummaryAt)`.
Permissions: `read("user:<userId>")`. Writes go through `identity PATCH /profile`, except `lastInvoiceNumber` (`statements`) and `nextSummaryAt` (also `scheduler`).

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
| `settingsJson` | text | `GroupSettings` (below) |
| `archivedAt` | datetime? | Archived groups are read-only |

Indexes: `idx_nextCloseAt (nextCloseAt)`.
Permissions: `read("team:<groupId>")`.

```ts
type GroupSettings =
  | { type: 'employer'; defaultRateCents: number; paymentTermsDays: number; autoFinalize: boolean;
      recipients: string[] /* billing emails */ }   // auto-posting is per schedule (schedules.autoPost)
  | { type: 'house'; autoFinalize: boolean; defaultBillSplit: 'days' | 'equal' }
  | { type: 'personal' }
  | { type: 'pair' }
```

## members

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `personId` | varchar(36) | |
| `displayName` | varchar(100) | What this group calls the person |
| `role` | enum(admin, member, viewer) | Authority inside the group ([permissions](permissions.md)) |
| `status` | enum(placeholder, active, left) | `placeholder`: hasn't joined this group, with or without an account. `active`: joined. `left`: joined, then moved out. A member who moves out before joining stays `placeholder` ([D-016](decisions.md)). Written only by the `groups` and `identity` functions. |
| `joinedOn` | varchar(10) | Local date. The `groups` function sets it to the day they were added unless the caller gives one (not a database default). |
| `leftOn` | varchar(10)? | Local date |

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
| `totalCents` | integer | Negative only for refunds |
| `inputJson` | text | The parts of the user's input that have no column of their own: `payers`, `split`, `shift`, `bill` (period only; its status and `dueOn` live in the `status` and `dueOn` columns), `payment`, `adjustment`, `note`. Types in [Functions API](functions-api.md#transactioninput). |
| `dueOn` | varchar(10)? | Bills only |
| `scheduleId` | varchar(36)? | Set on occurrences created by a schedule |
| `overridden` | boolean | default `false`. The user edited this occurrence. |
| `statementId` | varchar(36)? | Set when a final statement locks it |
| `receiptFileIds` | varchar(36)[]? | Files in the `receipts` bucket |
| `startedAt` | datetime? | Timer shifts |
| `remindedAt` | datetime? | Last reminder sent (bill due, long-running timer) |
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

Items get `ID.unique()` IDs and are rebuilt completely on every edit, like shares.
Indexes: `idx_transaction_position (transactionId, position)`.
Permissions: `read("team:<groupId>")` (the function sets the group's team when it writes).

## schedules

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `kind` | enum(shift, bill, expense, income) | |
| `description` | varchar(200) | |
| `templateJson` | text | `ScheduleInput.template`: a `TransactionInput` without `id`, `groupId`, `date`, `kind` and `description` (those live on the schedule) |
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

Append-only. Never updated or deleted, except when anonymising a deleted account.

| Column | Type | Notes |
| --- | --- | --- |
| `groupId` | varchar(36) | |
| `actorPersonId` | varchar(36)? | Empty for system jobs |
| `action` | varchar(48) | e.g. `transaction.created`, `member.added`, `statement.finalized` |
| `transactionId` | varchar(36)? | |
| `summary` | varchar(255) | Human-readable, e.g. "Alice changed Electricity from $90.00 to $95.00" |
| `changesJson` | text? | `{ before, after }` of the changed fields |
| `at` | datetime | |

Indexes: `idx_group_at (groupId, at)`.
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

## Storage buckets

| Bucket | Who uploads | File permissions | Limits |
| --- | --- | --- | --- |
| `receipts` | Clients, directly | Client sets `read("team:<groupId>")` at upload. Appwrite only lets a user grant roles they hold. | 10 MB; jpg, jpeg, png, webp, heic, pdf |
| `statements` | `statements` function | `read("team:<groupId>")` | 10 MB; PDFs only |

Bucket-level permission on `receipts`: `create("users")`. File security on for both buckets.

## Derived and copied data

Each item below has exactly one writer and can be rebuilt from its source. Nothing else is copied.

| Data | Source | Written by |
| --- | --- | --- |
| `shares` rows | `transactions.inputJson` + `items` + members | `ledger` (and `scheduler` when it auto-posts, through the same core function) |
| `shares.groupId/date/kind/category` | the transaction | rebuilt with the shares |
| `statements.snapshotJson`, PDFs | transactions and shares at finalize time | `statements` (an intentional historical snapshot) |
| `balances` table (M4) | shares | `ledger`, inside the same transaction |

## Categories

Defined once in `packages/core` (`CATEGORIES`): `rent`, `electricity`, `gas`, `water`, `internet`, `phone`, `groceries`, `household`, `food`, `transport`, `entertainment`, `health`, `work`, `subscriptions`, `other`.
