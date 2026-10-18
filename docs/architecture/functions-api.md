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
- The function gets the caller from the `x-appwrite-user-id` header and talks to the database with the per-execution API key in the `x-appwrite-key` header.

## Response envelope

```ts
type Ok<T>  = { ok: true; data: T }
type Err    = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
```

| Code | HTTP | When |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No signed-in user |
| `VALIDATION_FAILED` | 400 | Payload failed the zod schema or a ledger rule. `details` holds the issues. |
| `NOT_A_MEMBER` | 403 | Caller isn't an active member of the group |
| `FORBIDDEN` | 403 | Caller's role can't do this |
| `NOT_FOUND` | 404 | Row doesn't exist, or the caller can't see it |
| `CONFLICT` | 409 | Same ID with different content, duplicate member, timer already running |
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
  bill?: { status: 'due' | 'paid'; dueOn?: LocalDate; periodStart?: LocalDate; periodEnd?: LocalDate }
  payment?: { fromPersonId: string; toPersonId: string }
  adjustment?: { shares: { personId: string; givenCents: number; receivedCents: number }[]; reason: string }
  receiptFileIds?: string[]
  note?: string                 // up to 1000 chars
}

type ItemInput = { name: string; quantity?: number; amountCents: number; category?: Category; split: SplitSpec }

type TransactionView = { transaction: TransactionRow; shares: ShareRow[]; items: ItemRow[] }
```

`TransactionRow`, `ShareRow` and the other `*Row` types are generated from the schema with `appwrite types` ([data model](data-model.md)).

---

## ledger

All money writes.

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /transactions` | `TransactionInput` | `TransactionView` | admin, member |
| `PATCH /transactions/{id}` | `TransactionInput` (same `id`) | `TransactionView` | creator or admin; not locked |
| `POST /transactions/{id}/post` | `{ date?, payers?, shift?: { minutes?, rateCents?, breakMinutes? } }` | `TransactionView` | creator or admin; status `scheduled` or `due` |
| `POST /transactions/{id}/void` | `{ reason: string }` | `TransactionView` | creator or admin; not locked |
| `POST /timer/start` | `{ groupId, rateCents?, description? }` | `TransactionView` | admin (employer group) |
| `POST /timer/stop` | `{ transactionId, breakMinutes? }` | `TransactionView` | the person who started it |
| `GET /groups/{groupId}/balances` | none | `{ people: { personId, netCents }[], transfers: { fromPersonId, toPersonId, cents }[] }` | any member |

What every write does, in **one TablesDB transaction**:

1. Validate the body with zod, then check membership, role, archived and locked.
2. Run `buildShares()` and `assertShareInvariants()` from `packages/core`.
3. Write the transaction row, replace its items and shares, and append an `activity` row.
4. Commit. On conflict, retry once from step 1.

`/balances` is a function, not a client-side sum, so that later switching to the `balances` cache table doesn't change any client.

## groups

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /groups` | `{ id, type, name, currency?, timezone?, region?, statementCycle?, cycleAnchor?, settings?, counterpart?: { displayName, email?, phone? } }` | `{ group, members }` | any user (not `personal`; bootstrap makes that) |
| `PATCH /groups/{id}` | `{ name?, timezone?, region?, statementCycle?, cycleAnchor?, settings? }` | `group` | admin |
| `POST /groups/{id}/archive` | none | `group` | admin |
| `POST /groups/{id}/members` | `{ displayName, email?, phone?, userId?, role?, joinedOn? }` | `member` | admin (house: member too) |
| `PATCH /groups/{id}/members/{memberId}` | `{ displayName?, role?, joinedOn?, leftOn? }` | `member` | admin |
| `DELETE /groups/{id}/members/{memberId}` | none | `{}` | admin; only if they have no shares |
| `POST /groups/{id}/leave` | none | `{}` | the member; only if their balance is 0 |

`counterpart` is required for `employer` and `pair` groups. It creates the second member (a placeholder unless their identity already has an account). `currency` cannot change after the group's first transaction.

## identity

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /bootstrap` | `{ timezone }` | `{ profile, personId, personalGroupId, linkedGroupIds }` | the user; idempotent |
| `PATCH /profile` | `{ displayName?, timezone?, region?, currency?, business?, invoicePrefix?, summaryFrequency? }` | `profile` | the user |
| `POST /claim` | none | `{ linkedGroupIds: string[] }` | the user |
| `POST /invites` | `{ groupId, memberId, channel: 'email' \| 'sms' }` | `{ sentAt, expiresAt }` | see [permissions](permissions.md) |
| `POST /invites/accept` | `{ token }` | `{ groupId }` or `{ needsVerification: 'email' \| 'phone' }` | signed-in user |

Details: [People, identity and invites](identity-and-invites.md).

## scheduler

Cron: `5 * * * *`. HTTP routes:

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /schedules` | `ScheduleInput` | `{ schedule, created: number }` | admin; house members for their own |
| `PATCH /schedules/{id}` | `ScheduleInput` (same `id`) | `{ schedule, created, removed }` | creator or admin |
| `POST /schedules/{id}/end` | `{ endsOn: LocalDate }` | `{ schedule, removed }` | creator or admin |
| `DELETE /schedules/{id}` | none | `{}` | creator or admin; no posted occurrences |
| `POST /schedules/preview` | `ScheduleInput` without `id` + `{ count?: number }` | `{ dates: LocalDate[], skipped: { date, reason }[] }` | any member |

```ts
type ScheduleInput = {
  id: string
  groupId: string
  kind: 'shift' | 'bill' | 'expense' | 'income'
  description: string
  template: Omit<TransactionInput, 'id' | 'groupId' | 'date' | 'kind' | 'description'>
  rrule: string                 // RFC 5545
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

`createHandler` (in `packages/server`) does the routing by method and path, reads the caller, turns `AppError` into the envelope above and logs one structured line per request (no personal data).
