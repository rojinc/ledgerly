# Functions API

Every write goes through one of five Appwrite Functions. This page is the **contract** between frontend and backend: routes, payloads, responses and errors. The zod schemas in `packages/core/src/schemas/` are the code version of this page. Change both in the same `contract` PR.

## Calling a function

The web app uses one helper, `callFunction()` in `apps/web/src/lib/api.ts`:

```ts
const execution = await functions.createExecution({
  functionId: 'ledger',
  body: JSON.stringify(payload),
  async: false,            // synchronous: we wait for the response
  xpath: '/transactions',  // route path
  method: ExecutionMethod.POST,
})
// execution.responseStatusCode, execution.responseBody (JSON string)
```

- Synchronous executions have a **30-second hard limit**. Every route must finish well within it (target under 2 seconds).
- `statements … /finalize` is called with `async: true`. Async executions return no body, so the UI watches the statement row through Realtime until it is `final`.
- The function gets the caller by verifying the JWT in the `x-appwrite-user-jwt` header with Appwrite. It never trusts `x-appwrite-user-id`, which a client can forge ([permissions](permissions.md#function-side-checks)). It talks to the database with the per-execution API key in the `x-appwrite-key` header.

## Response envelope

```ts
type Ok<T>  = { ok: true; data: T }
type Err    = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
```

| Code | HTTP | When |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No signed-in user |
| `VALIDATION_FAILED` | 400 | Payload failed the zod schema or a ledger rule. `details` holds the issues. |
| `NOT_A_MEMBER` | 403 | Caller has no member row in the group, or hasn't joined it (`placeholder`) |
| `FORBIDDEN` | 403 | Caller's role can't do this |
| `NOT_FOUND` | 404 | Row doesn't exist, or the caller can't see it |
| `CONFLICT` | 409 | Same ID with different content, duplicate member, timer already running, finalizing a draft that isn't the oldest, another request changed the same rows at the same time (try again) |
| `LOCKED` | 409 | Transaction is locked, or its period is being finalized |
| `ARCHIVED` | 409 | Group is archived |
| `INVITE_INVALID` | 400 | Invite token unknown, expired or used |
| `RATE_LIMITED` | 429 | Too many invites |
| `INVARIANT_VIOLATION` | 500 | A ledger invariant would break. Must never happen; logged as an error. |
| `INTERNAL` | 500 | Anything else |

## Idempotency

- Creating something takes a **client-generated `id`** (`ID.unique()`). If a row with that ID exists **with the same content**, the function returns it with 200. If the content differs, it returns `CONFLICT`. So the app can safely retry after a timeout or a lost connection.
- Updates are naturally idempotent: the same body twice gives the same result.

## Shared types

```ts
type LocalDate = string // 'YYYY-MM-DD'
type Category = 'rent' | 'electricity' | 'gas' | 'water' | 'internet' | 'phone' | 'groceries'
  | 'household' | 'food' | 'transport' | 'entertainment' | 'health' | 'work' | 'subscriptions' | 'other'

type SplitSpec =  // see ledger.md#splits
  | { mode: 'equal';   personIds: string[] }
  | { mode: 'exact';   amounts: { personId: string; cents: number }[] }
  | { mode: 'percent'; percents: { personId: string; basisPoints: number }[] }
  | { mode: 'weights'; weights: { personId: string; weight: number }[] }
  | { mode: 'days';    personIds?: string[] }
```

### TransactionInput

```ts
type TransactionInput = {
  id: string                    // ID.unique() from the client
  groupId: string
  kind: 'shift' | 'expense' | 'bill' | 'payment' | 'loan' | 'income' | 'adjustment'
  date: LocalDate               // in the group's timezone; at most 1 year in the future
  description: string           // 1–200 chars
  category?: Category
  totalCents?: number           // required unless kind = shift (computed) or items are given (sum of items)
  payers?: { personId: string; cents: number }[]   // default: the caller pays everything
  split?: SplitSpec             // expense, bill, loan
  items?: ItemInput[]           // expense, bill; at most 30
  shift?: {                     // kind = shift
    minutes: number             // paid minutes, after breaks
    rateCents: number           // per hour
    breakMinutes?: number
    startTime?: string          // 'HH:mm', for display
    endTime?: string
  }
  bill?: { status: 'due' | 'paid'; dueOn?: LocalDate; periodStart?: LocalDate; periodEnd?: LocalDate } // dueOn required when status is 'due'; schedule templates leave it out
  payment?: { fromPersonId: string; toPersonId: string }
  adjustment?: { shares: { personId: string; givenCents: number; receivedCents: number }[]; reason: string }
  receiptFileIds?: string[]
  note?: string                 // up to 1000 chars
}

type ItemInput = { name: string; quantity?: number; amountCents: number; category?: Category; split: SplitSpec }

type TransactionView = { transaction: Transactions; shares: Shares[]; items: Items[] }
```

Row types (`Transactions`, `Shares`, `Items` and one per table) are generated from the schema with `npm run appwrite:types` into `@ledgerly/core/generated/rows` ([data model](data-model.md)). Never edit them by hand.

### Validation

Each route parses its body with its schema from `packages/core/src/schemas/` before doing anything else. Beyond the types on this page, the schemas enforce:

- **No unknown keys.** A misspelled or extra field returns `VALIDATION_FAILED`; it is never silently dropped.
- **Text** is trimmed, then must fit its column ([data model](data-model.md)): descriptions and reasons 1–200 characters, names 1–100 (item names 1–120), notes up to 1000. Time zones are IANA names (`Australia/Sydney`, `UTC`), not offsets.
- **Amounts** are integer cents, at most `MAX_AMOUNT_CENTS` in size, and so are computed totals: a shift's `minutes × rateCents / 60` and the sum of the `items`. Rates are ≥ 0. A shift's `minutes` and `breakMinutes` are at most 1440 (one day).
- **People:** a list names each person at most once, and a transaction names at most 15 people in all.
- **Kinds:** `shift`, `bill`, `payment` and `adjustment` are required for their own kind and rejected on any other. `payers` and `split` are for expense, bill and loan; `items` (1–30) for expense and bill; a `days` split for bills only. `totalCents` is required unless the kind is `shift` (where it is computed, so it is rejected) or there are `items`. A payment's `fromPersonId` and `toPersonId` must be different people. Sums against the total (payers, `exact` splits, items) and the sign rules are ledger rules, checked by `buildShares()`.
- **Bills** (one-off transactions, not schedule templates): a `due` bill needs `dueOn`, and a `days` split needs `periodStart` and `periodEnd`.
- **Dates** must be real calendar dates, and a range (`periodStart`–`periodEnd`, `startsOn`–`endsOn`, `joinedOn`–`leftOn`, `POST /statements/reissue`) must not end before it starts. "At most 1 year in the future" needs today's date, so the function checks it.
- **Lists:** at most 10 `receiptFileIds` (the ledger function checks each file) and 366 `exdates`.
- **Groups:** `counterpart` is only for employer and pair groups. On `POST /groups`, `settings.type` must match the group's `type`. A `weekly` or `fortnightly` cycle needs `cycleAnchor` (on `PATCH`, the function checks it against the stored group). Employer `recipients` has at most 10 addresses (each is emailed every invoice); `paymentTermsDays` is 0–365.
- **Business details:** `abn` (11), `bsb` (6) and `accountNumber` (up to 12) are stored as digits only. Spaces and dashes are dropped.
- **Schedules:** `rrule` is one of the shapes in [Rules the UI builds](scheduling.md#rules-the-ui-builds): weekly on plain `BYDAY` codes with an optional `INTERVAL` of 1–4, or monthly on a `BYMONTHDAY` of 1–28 or `-1`, either with an optional `COUNT` (1–500) or `UNTIL=YYYYMMDD`, not both. `UNTIL` is not before `startsOn`, and an unknown rule part gets the fixed message "Unsupported rule part". `startsOn`, `endsOn` and `exdates` are on or after 2000-01-01. The preview `count` is 1–100.
- **Invites:** `POST /invites/accept` takes any token text up to 128 characters. A malformed token is just an unknown one, so it returns `INVITE_INVALID`.

---

## ledger

All money writes.

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /transactions` | `TransactionInput` | `TransactionView` | admin, member |
| `PATCH /transactions/{id}` | `TransactionInput` (same `id`) | `TransactionView` | creator or admin; not locked |
| `POST /transactions/{id}/post` | `{ date?, payers?, shift?: { minutes?, rateCents?, breakMinutes? } }` | `TransactionView` | creator or admin; status `scheduled` or `due` |
| `POST /transactions/{id}/void` | `{ reason: string }` | `TransactionView` | creator or admin; not locked |
| `POST /timer/start` | `{ id, groupId, rateCents?, description? }` | `TransactionView` | admin (employer group) |
| `POST /timer/stop` | `{ transactionId, breakMinutes? }` | `TransactionView` | the person who started it |
| `GET /groups/{groupId}/balances` | none | `{ people: { personId, netCents }[], transfers: { fromPersonId, toPersonId, cents }[] }` | any member |

What every write does, in **one TablesDB transaction**:

1. Validate the body with zod, then check membership, role, archived and locked.
2. Run `buildShares()` and `assertShareInvariants()` from `packages/core`.
3. Write the transaction row, replace its items and shares, and append an `activity` row.
4. Commit. On conflict, retry once from step 1.

`/balances` is a function, not a client-side sum, so that later switching to the `balances` cache table doesn't change any client.

A `PATCH` that changes a bill's `dueOn` clears `remindedAt`, so the new date gets its own reminder.

## groups

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /groups` | `{ id, type, name, currency?, timezone?, region?, statementCycle?, cycleAnchor?, settings?, counterpart?: { displayName, email?, phone? } }` | `{ group, members }` | any user (not `personal`; bootstrap makes that) |
| `PATCH /groups/{id}` | `{ name?, currency?, timezone?, region?, statementCycle?, cycleAnchor?, settings? }` | `group` | admin |
| `POST /groups/{id}/archive` | none | `group` | admin |
| `POST /groups/{id}/members` | `{ displayName, email?, phone?, role?, joinedOn? }` | `member` | admin (house: member too) |
| `PATCH /groups/{id}/members/{memberId}` | `{ displayName?, role?, joinedOn?, leftOn? }` | `member` | admin |
| `DELETE /groups/{id}/members/{memberId}` | none | `{}` | admin; only if they have no shares. Also removes any team membership. |
| `POST /groups/{id}/leave` | none | `{}` | the member; only if their balance is 0 and they aren't the last joined admin |

`counterpart` is required for `employer` and `pair` groups. It creates the second member, always as a placeholder ([D-016](decisions.md)). These groups always have exactly these two members; adding another returns `VALIDATION_FAILED`. `currency` cannot change after the group's first transaction (`VALIDATION_FAILED`).

Archiving is permanent in v1; there is no unarchive route. A `personal` group can't be archived (`VALIDATION_FAILED`).

## identity

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /bootstrap` | `{ timezone }` | `{ profile, personId, personalGroupId, linkedGroupIds }` | the user; idempotent |
| `PATCH /profile` | `{ displayName?, timezone?, region?, currency?, business?, invoicePrefix?, summaryFrequency? }` | `profile` | the user |
| `POST /claim` | none | `{ linkedGroupIds: string[] }` | the user |
| `POST /invites` | `{ groupId, memberId, email?, phone? }` (exactly one) | `{ sentAt, expiresAt }` | see [permissions](permissions.md) |
| `POST /invites/accept` | `{ token }` | `{ groupId }` or `{ needsVerification: 'email' \| 'phone' }` | signed-in user |
| `GET /groups/pending` | none | `{ groups: { id, type, name, archivedAt }[] }` | the user |
| `POST /groups/{id}/join` | none | `{ group, member }` | the user |

`PATCH /profile` changes only the fields given; `business`, when given, replaces the stored business details as a whole.

`linkedGroupIds` (`/bootstrap`, `/claim`) lists only the groups joined in that call, so after a retry it leaves out groups an earlier, interrupted call already joined.

`/groups/pending` and `/join` are how someone who already had an account when they were added joins a group ([Joining a group](identity-and-invites.md#joining-a-group)). Both act only on the caller's own person:

- `/groups/pending` lists the groups where that person is a `placeholder` member (`members.idx_person_status`), archived ones included.
- `/join` reads the caller's member row in that group first, so someone who isn't in the group learns nothing about it; with no row it returns `NOT_A_MEMBER`. It then runs the steps in [Joining a group](identity-and-invites.md#joining-a-group): team first, then `active` (or `left` if `leftOn` is set) with a `member.joined` row. If the row is already `active` or `left`, it returns `{ group, member }` unchanged and doesn't touch the team, so a retry is safe. Joining writes no ledger data, so it works on archived groups, the same as claim and invites.

Details: [People, identity and invites](identity-and-invites.md).

## scheduler

Cron: `5 * * * *`, sent as `POST /` with the `schedule` trigger. A person calling `POST /` gets `FORBIDDEN`, and a call without a JWT `UNAUTHENTICATED`. HTTP routes:

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /schedules` | `ScheduleInput` | `{ schedule, created: number }` | admin; house members for their own |
| `PATCH /schedules/{id}` | `ScheduleInput` (same `id`) | `{ schedule, created, removed }` | creator or admin |
| `POST /schedules/{id}/end` | `{ endsOn: LocalDate }` | `{ schedule, removed }` | creator or admin |
| `DELETE /schedules/{id}` | none | `{}` | creator or admin; no posted occurrences |
| `POST /schedules/preview` | `ScheduleInput` without `id` + `{ count?: number }` (1–100, default 10) | `{ dates: LocalDate[], skipped: { date, reason: 'exdate' \| 'holiday' }[] }` | any member; not in an archived group |

```ts
type ScheduleInput = {
  id: string                    // ID.unique(), exactly 20 chars (occurrence IDs append _YYYYMMDD)
  groupId: string
  kind: 'shift' | 'bill' | 'expense' | 'income'
  description: string
  template: Omit<TransactionInput, 'id' | 'groupId' | 'date' | 'kind' | 'description'>
  rrule: string                 // RFC 5545; only the shapes in scheduling.md#rules-the-ui-builds
  startsOn: LocalDate
  endsOn?: LocalDate
  exdates?: LocalDate[]
  skipPublicHolidays: boolean
  autoPost: boolean
  horizonDays?: number          // 7–120, default 56
}
```

Details: [Scheduling](scheduling.md).

## statements

Cron: `15 * * * *`. HTTP routes:

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /statements/preview` | `{ groupId, periodEnd?: LocalDate }` | `{ snapshot }` (not saved) | any member |
| `POST /statements/{id}/refresh` | none | `statement` | any member; drafts only |
| `POST /statements/{id}/finalize` | `{ send: boolean }` | `statement` (call **async**) | admin |
| `POST /statements/{id}/send` | none | `{ sentAt }` | admin; final only |
| `POST /statements/{id}/void` | `{ reason }` | `statement` | admin; latest final only |
| `POST /statements/reissue` | `{ groupId, periodStart, periodEnd }` | `statement` (draft) | admin |

Details: [Statements and invoices](statements.md).

---

## Function code layout

```
functions/<name>/
  src/main.ts          entry point: export default createHandler(routes)
  src/routes/<route>.ts one file per route: schema + handler
  test/<route>.test.ts
```

`createHandler` (in `packages/server`) does the routing by method and path, verifies the caller's JWT ([permissions step 1](permissions.md#function-side-checks)), turns `AppError` into the envelope above and logs one structured line per request (no personal data).
