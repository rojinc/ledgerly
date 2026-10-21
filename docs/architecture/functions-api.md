# Functions API

Every write goes through one of six Appwrite Functions. This page is the **contract** between frontend and backend: routes, payloads, responses and errors. The zod schemas in `packages/core/src/schemas/` are the code version of this page, and the response types sit next to them (`TransactionView`, `Balances`, `BootstrapResult` and so on), so functions and the web app share one copy. Change both in the same `contract` PR.

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
- `statements … /finalize` is called with `async: true`. Async executions return no body, so the UI polls the execution (`functions.getExecution`) until it ends, then reads the statement row (`getRow`) ([#32](https://github.com/rojinc/ledgerly/issues/32#issuecomment-6249669348)). A failed execution, or one that ends with a status of 400 or more, is worded from its status code, so the screen never waits forever.
- The function gets the caller by verifying the JWT in the `x-appwrite-user-jwt` header with Appwrite. It never trusts `x-appwrite-user-id`, which a client can forge ([permissions](permissions.md#function-side-checks)). It talks to the database with the per-execution API key in the `x-appwrite-key` header.

## Response envelope

```ts
type Ok<T>  = { ok: true; data: T }
type Err    = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
```

| Code | HTTP | When |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No signed-in user. Also `identity POST /invites` and `POST /reminders` from a caller (the inviter or the sender) whose account deletion started while the request ran ([invites](identity-and-invites.md#invites), [reminders](identity-and-invites.md#reminders)); one that started before gets `NOT_A_MEMBER` ([permissions](permissions.md)) |
| `VALIDATION_FAILED` | 400 | Payload failed the zod schema or a ledger rule. When the schema fails, `details` holds the zod issues; receipts that can't be attached give one issue per file, in the same shape ([receipts](#ledger)). A ledger rule or any other check carries no `details`, only its message, except `account`'s two refusals that list theirs ([account](#account)). |
| `NOT_A_MEMBER` | 403 | Caller has no member row in the group, hasn't joined it (`placeholder`), or left it on their own (out of its team) |
| `FORBIDDEN` | 403 | Caller's role can't do this |
| `NOT_FOUND` | 404 | Row doesn't exist, or the caller can't see it |
| `CONFLICT` | 409 | Same ID with different content, duplicate member, timer already running, archiving a group with a timer running, finalizing a draft that isn't the oldest, discarding a statement that's being finalized, closing a period while another draft of the group is unfinished (`details: { draftId }`), another request changed the same rows at the same time (try again), a merge into one of the people is still open in the group (`details: { reason: 'merging' }`; try again shortly, [merging](identity-and-invites.md#while-a-merge-is-open-in-a-group)) |
| `LOCKED` | 409 | Transaction is locked, or its period is being finalized |
| `ARCHIVED` | 409 | Group is archived |
| `INVITE_INVALID` | 400 | Invite token unknown, expired, or the invite isn't the caller's (used by someone else, or its address is another account's) |
| `RATE_LIMITED` | 429 | Too many invites or reminders, or too many wrong addresses typed for them ([#274](https://github.com/rojinc/ledgerly/issues/274)), or adds with both an email and a phone counted with them ([#378](https://github.com/rojinc/ledgerly/issues/378)) |
| `INVARIANT_VIOLATION` | 500 | A ledger invariant would break. Must never happen; logged as an error. |
| `INTERNAL` | 500 | Anything else |

## Idempotency

- Creating something takes a **client-generated `id`** (`ID.unique()`). If a row with that ID exists **with the same content**, the function returns it with 200. If the content differs, it returns `CONFLICT`. So the app can safely retry after a timeout or a lost connection.
- Updates are naturally idempotent: the same body twice gives the same result.
- **Exception:** `identity POST /reminders` answers any body with a used `id`, from the same sender in the same group, with the stored `{ sentAt }`. It sends the email again under the same key only while that key is live (under 23 hours) and the address and balance checks pass again ([reminders](identity-and-invites.md#reminders), step 3).
- **Exception:** `groups POST /groups` compares only the fields the body gives, and never `counterpart`, since resolving it again could find someone else. So a retry that leaves a field out, or names another counterpart, gets the stored `{ group, members }`, but only from the group's owner while they're still active in it. Anyone else gets `CONFLICT`.

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
  id: string                    // ID.unique() from the client; a new one never ends in _ and 8 digits (see ledger)
  groupId: string
  kind: 'shift' | 'expense' | 'bill' | 'payment' | 'loan' | 'income' | 'adjustment'
  date: LocalDate               // in the group's timezone; at most 1 year in the future
  description: string           // 1–200 chars
  category?: Category
  totalCents?: number           // required unless kind = shift (computed) or items are given (sum of items)
  payers?: { personId: string; cents: number }[]   // default: see "Payers when none are given" below
  split?: SplitSpec             // expense, bill, loan
  items?: ItemInput[]           // expense, bill; at most 30
  shift?: {                     // kind = shift
    minutes: number             // paid minutes, after breaks
    rateCents: number           // per hour
    breakMinutes?: number
    startTime?: string          // 'HH:mm', for display
    endTime?: string
  }
  bill?: { status: 'due' | 'paid'; dueOn?: LocalDate; periodStart?: LocalDate; periodEnd?: LocalDate } // dueOn required when status is 'due'; a schedule template is { status: 'due' } with no dueOn or period
  payment?: { fromPersonId: string; toPersonId: string }
  adjustment?: { shares: { personId: string; givenCents: number; receivedCents: number }[]; reason: string }
  receiptFileIds?: string[]     // at most 10, each once; a PATCH without it keeps the stored list
  note?: string                 // up to 1000 chars
}

type ItemInput = { name: string; quantity?: number; amountCents: number; category?: Category; split: SplitSpec }

type TransactionView = { transaction: Transactions; shares: Shares[]; items: Items[] }
```

Row types (`Transactions`, `Shares`, `Items` and one per table) are generated from the schema with `npm run appwrite:types` into `@ledgerly/core/generated/rows` ([data model](data-model.md)). Never edit them by hand.

### Validation

Each route parses its body with its schema from `packages/core/src/schemas/` before doing anything else. Beyond the types on this page, the schemas enforce:

- **No unknown keys.** A misspelled or extra field returns `VALIDATION_FAILED`; it is never silently dropped.
- **Text** is trimmed, then must fit its column ([data model](data-model.md)): descriptions and reasons 1–200 characters, names 1–100 (item names 1–120), notes up to 1000. A description is first folded to one line, so it prints as one in emails and PDFs ([#346](https://github.com/rojinc/ledgerly/issues/346)): bidi controls (Unicode `Bidi_Control`) and every other control character (`Cc`) that isn't whitespace are removed, each run of whitespace (`White_Space`, line breaks and tabs included) becomes one space, and it's trimmed. The zero-width joiner stays, so emoji sequences hold. Its length counts after the fold, so one of nothing else is refused as empty. Emails fold the names they show the same way (`oneLine()` in `packages/core/src/schemas/common.ts`). Time zones are IANA names (`Australia/Sydney`, `UTC`), not offsets.
- **Amounts** are integer cents, at most `MAX_AMOUNT_CENTS` in size, and so are computed totals: a shift's `minutes × rateCents / 60` and the sum of the `items`. Rates are ≥ 0. A shift's `minutes` and `breakMinutes` are at most 1440 (one day).
- **People:** a list names each person at most once, and a transaction names at most 15 people in all.
- **Kinds:** `shift`, `bill`, `payment` and `adjustment` are required for their own kind and rejected on any other. `payers` and `split` are for expense, bill and loan; `items` (1–30) for expense and bill; a `days` split for bills only. `totalCents` is required unless the kind is `shift` (where it is computed, so it is rejected) or there are `items`. A payment's `fromPersonId` and `toPersonId` must be different people. Sums against the total (payers, `exact` splits, items) and the sign rules are ledger rules, checked by `buildShares()`.
- **Bills:** a one-off `due` bill needs `dueOn`, and a `days` split needs `periodStart` and `periodEnd`. A schedule's bill template has status `due` and no `dueOn`, `periodStart`, `periodEnd` or `days` split ([scheduling](scheduling.md#what-a-schedule-is)).
- **Dates** must be real calendar dates, and a range (`periodStart`–`periodEnd`, `startsOn`–`endsOn`, `joinedOn`–`leftOn`, `POST /statements/reissue`) must not end before it starts. "At most 1 year in the future" needs today's date, so the function checks it, and so is a schedule's `startsOn` at most 31 days before today on `POST /schedules` and on a `PATCH` that changes it, so a mistyped year can't make years of past occurrences.
- **Lists:** at most 10 `receiptFileIds`, each at most once (the ledger function checks each file), and 366 `exdates`. Schedule templates have no `receiptFileIds`.
- **Groups:** `counterpart` is only for employer and pair groups. On `POST /groups`, `settings.type` must match the group's `type`. A `weekly` or `fortnightly` cycle needs `cycleAnchor` (on `PATCH`, the function checks it against the stored group). Employer `recipients` has at most 10 addresses (each is emailed every invoice); `paymentTermsDays` is 0–365; `autoSend` needs `autoFinalize` and at least one recipient ([auto-send](statements.md#auto-send)). `region` must be a country or state the public holiday library knows (`publicHolidayChecker`), checked by the function on create and `PATCH`.
- **Business details:** `abn` (11), `bsb` (6) and `accountNumber` (up to 12) are stored as digits only. Spaces and dashes are dropped.
- **Schedules:** `rrule` is one of the shapes in [Rules the UI builds](scheduling.md#rules-the-ui-builds): weekly on plain `BYDAY` codes with an optional `INTERVAL` of 1–4, or monthly on a `BYMONTHDAY` of 1–28 or `-1`, either with an optional `COUNT` (1–500) or `UNTIL=YYYYMMDD`, not both. `UNTIL` is not before `startsOn`, and an unknown rule part gets the fixed message "Unsupported rule part". `startsOn`, `endsOn` and `exdates` are on or after 2000-01-01. The preview `count` is 1–100.
- **Invites:** `POST /invites/accept` takes any token text up to 128 characters. A malformed token is just an unknown one, so it returns `INVITE_INVALID`.

---

## ledger

All money writes.

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /transactions` | `TransactionInput` | `TransactionView` | admin, member |
| `PATCH /transactions/{id}` | `TransactionInput` (same `id`) | `TransactionView` | creator or admin; not locked (`LOCKED`); not voided or a running timer, with the same `groupId` and `kind`, and for a bill the same due or paid state (`VALIDATION_FAILED`; a due bill is paid with `/post`) |
| `POST /transactions/{id}/post` | `{ date?, payers?, shift?: { minutes?, rateCents?, breakMinutes? } }` | `TransactionView` | creator or admin; status `scheduled` or `due` |
| `POST /transactions/{id}/void` | `{ reason: string }` | `TransactionView` | creator or admin; not locked |
| `POST /transactions/{id}/receipts` | `{ receiptFileIds: string[] }` (the whole new list, 0–10) | `TransactionView` | creator or admin; not locked |
| `POST /timer/start` | `{ id, groupId, rateCents?, description? }` | `TransactionView` | an admin who is the group's owner, the person it pays (employer group) |
| `POST /timer/stop` | `{ transactionId, breakMinutes? }` | `TransactionView` | the person who started it, while an admin or member |
| `GET /groups/{groupId}/balances` | none | `{ people: { personId, netCents }[], transfers: { fromPersonId, toPersonId, cents }[] }` | any member |

What every write does, in **one TablesDB transaction**:

1. Validate the body with zod, then check membership, role, archived and locked.
2. Run `buildShares()` and `assertShareInvariants()` from `packages/core`.
3. Write the transaction row, replace its items and shares, and append an `activity` row.
4. Commit. On conflict, retry once from step 1.

`POST /transactions` and `POST /timer/start` refuse an `id` that ends in `_` and 8 digits (`VALIDATION_FAILED`, "This id is kept for schedule occurrences."): `<scheduleId>_<YYYYMMDD>` is a schedule occurrence's ID, and taking one would stop the scheduler creating it ([scheduling](scheduling.md#idempotency)).

On `PATCH`, `/post`, `/void`, `/receipts` and `/timer/stop`, a caller who isn't a member of the transaction's group gets `NOT_FOUND`, the same answer as for an ID that doesn't exist, so the route doesn't say which IDs are in use. The scheduler's `PATCH /schedules/{id}`, `/end` and `DELETE` do the same for a schedule's group.

`/balances` is a function, not a client-side sum, so the `balances` cache changes no client. It reads the group's `balances` row ([ledger](ledger.md#balances)): one read. A group with no row, or whose row can't be read, fails `balancesPeopleSchema` or has nets that don't add up to 0 (each logged as an error), is summed from its shares, reading again until the group's `rev` is the same before and after. The response is the same either way, and a sum that doesn't add up to 0 is `INVARIANT_VIOLATION`.

- `people` has one entry per person with shares in the group, sorted by `personId`. Anyone else is at 0.
- It reads the shares a page at a time, then the group row again. Every write of shares writes a fresh `rev` to the group row ([concurrency](ledger.md#concurrency)). So if `rev` changed, or a page's cursor row was deleted, a write committed during the read, and it reads again. After 3 reads like that, it gives `CONFLICT`.
- A whole read whose shares don't add up to 0 gives `INVARIANT_VIOLATION`.

A `PATCH` that changes a bill's `dueOn`, or a `scheduled` row's `date`, clears `remindedAt`, so the new date gets its own reminder. An auto-post occurrence cleared this way is one step 2 posts again: on its new date, or at the next hourly run if that date has passed, unless step 2's rules hold it back (a date before the day it was made, or more than 7 days ago; [auto-post](scheduling.md#step-2-auto-post)).

**Deleted people.** `POST /transactions`, `PATCH`, `/post` and `POST /timer/start` refuse, with `VALIDATION_FAILED`, a write that would newly name a person with `deletedAt`, **in a group where that person's member row isn't `placeholder`**.

- **Who a write names:** everyone it gives a share, or would once posted, and everyone its input names. That's its payers (the payer the server fills in included), its split or the default split, its items, and a shift's two people.
- **Newly:** not on the transaction already. On it already are:
  - the people its stored input names (`everyPersonId()`: payers, the split, items);
  - those holding one of its shares;
  - for a posted shift, its two people, so one of no minutes, with no shares, can still be corrected;
  - for a row not yet posted that was made before their account was deleted (its `$createdAt` earlier than their `deletedAt`), those its stored input splits it to, by its split or the default split, and a shift's two people. That's the stored input as it is, never this request's `date` or `payers`, and a payer the server fills in never counts.

  For a create or a timer start, everyone counts as newly named. A row whose create raced the deletion may count as made after it.
- **So a row made before the deletion** can still be posted as it is, and edited, even where only its default split or its shift gives them a share. An edit that gives them their first share (a new date in a house, say) is refused. **A row made after it** can't give them a share.
- **Exempt:** payments and adjustments, so balances with a former member can still be settled; and `POST /timer/stop`, since the timer was checked when it started and its shares go to the same two people.
- Where they never joined, nothing is refused, so the answer can't show that they deleted their account ([D-016](decisions.md#d-016-being-added-to-a-group-doesnt-make-you-a-member-you-join)). A transaction that already names them can still be corrected, posted and voided ([deleting an account](identity-and-invites.md#deleting-an-account-m4)).
- **Schedules:** the scheduler's `POST` and `PATCH /schedules`, and `POST /schedules/{id}/resume`, apply the same rule to a trial occurrence on the first date the save can make one: `startsOn`, or for `PATCH` and a resume the later of `startsOn` and today in the group's time zone. Its payer, when the template names none, is the schedule's creator, as in the ledger-rules trial ([scheduling](scheduling.md#schedule-routes)). `PATCH` and a resume check everyone the trial names, those the stored template named included. On the deletion day they're still in a house's default split (their `leftOn` is today), so a schedule that keeps it can be added or edited again from the next day.
- **A schedule a deleted person created can't be edited or resumed:** `PATCH /schedules/{id}` and `/resume` refuse (`VALIDATION_FAILED`) while its creator has `deletedAt`. It can still be paused, ended or deleted, and an admin adds a new schedule instead. Deleting an account ends the schedules the person created, or whose template names them (`everyPersonId()`), and in a kept `pair` or `employer` group every schedule made before the deletion; an edit could otherwise start one again.

**Merges still open.** `PATCH` and `/post` refuse with `CONFLICT` (`details: { reason: 'merging' }`) a row whose stored shares, input or item splits name a person whose merge is still open in the group ([merging](identity-and-invites.md#while-a-merge-is-open-in-a-group)). The app asks to try again shortly.

**Payers when none are given.** On `POST /transactions`, a posted row's payer is the caller, who pays everything, and that payer is stored in `inputJson`. A due bill stores none: whoever posts it pays (`/post`, below). On `PATCH`, whoever paid before still pays, not the person editing: the single stored payer; the creator, for a posted row with several stored payers or none; the person editing, for an unposted row (it stores none). On `/post`, the body's payers, else the stored ones, else the caller.

`/post` on a transaction that is already posted, with the same date and payers, returns it unchanged (a retried post); anything else on a posted row is `VALIDATION_FAILED`.

**Receipts.** `POST /transactions/{id}/receipts` sets the transaction's receipt list and changes nothing else. It rebuilds no shares or items, and writes one `transaction.updated` activity row; sending the stored list again, in the same order, writes nothing. Otherwise its rules are `PATCH`'s: status `scheduled`, `due` or `posted`, `LOCKED` and `ARCHIVED` as for `PATCH`, `NOT_FOUND` for non-members, and it sets `overridden` on a schedule occurrence.

- Every write that attaches a file (`POST /transactions`, `PATCH` and `/receipts`) checks it and limits it to the group's team first ([permissions](permissions.md#storage)). The check runs after step 1's membership, role, archived and locked checks, so a caller those checks refuse never changes a file.
- A `PATCH` body without `receiptFileIds` keeps the stored list, so edit forms that don't show receipts don't drop them. `[]` clears it.
- Taking a file off a list doesn't delete it or change its permissions. Once no transaction lists it, the scheduler deletes it 24 hours later ([step 5](scheduling.md#step-5-receipt-clean-up)); putting it back on a transaction before then keeps it. A file the scheduler has started deleting is refused like a missing one. The same file may be on two transactions of one group.

## groups

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /groups` | `{ id, type, name, currency?, timezone?, region?, statementCycle?, cycleAnchor?, settings?, counterpart?: { displayName, email?, phone? } }` | `{ group, members }` | any user (not `personal`; bootstrap makes that) |
| `PATCH /groups/{id}` | `{ name?, currency?, timezone?, region?, statementCycle?, cycleAnchor?, settings? }` | `group` | admin |
| `POST /groups/{id}/archive` | none | `group` | admin |
| `POST /groups/{id}/unarchive` | none | `group` | admin |
| `POST /groups/{id}/members` | `{ displayName, email?, phone?, role?, joinedOn? }` | `member` | admin (house: member too) |
| `PATCH /groups/{id}/members/{memberId}` | `{ displayName?, role?, joinedOn?, leftOn?: LocalDate \| null }` | `member` | admin; `leftOn: null` moves someone who moved out back in ([leaving](permissions.md#leaving-a-group)); not a change of role or `leftOn` that leaves the group with no joined admin (`VALIDATION_FAILED`, "The group needs at least one admin who has joined.") |
| `DELETE /groups/{id}/members/{memberId}` | none | `{}` | admin; only if they have no shares, aren't named in an unposted transaction or a schedule template, and didn't create a schedule whose template names no payers (`VALIDATION_FAILED`); not the last joined admin (`VALIDATION_FAILED`, as for `PATCH`); not while a person merged into them still has shares there, or is named in an unposted transaction or template there, with that merge open in the group (`CONFLICT`, [merging](identity-and-invites.md#while-a-merge-is-open-in-a-group)). Also removes any team membership. In the same transaction it gives the person a fresh `rev`, and `orphanedAt` when the row was a lone placeholder's last (`isPlaceholder()`, no other member row); the person, its identities and the invites stay, and [scheduler step 5c](scheduling.md#step-5c-placeholder-clean-up) deletes that placeholder's identities and name 30 days later ([permissions](permissions.md#leaving-a-group)). |
| `POST /groups/{id}/leave` | none | `{}` | the member; only if their balance is 0, they aren't the last joined admin, they aren't the last person in an archived group's team (`VALIDATION_FAILED`: they delete the group instead, [#486](https://github.com/rojinc/ledgerly/issues/486)), and no person merged into them still has shares there with that merge open in the group (`CONFLICT`), except a retry of their own leave cut off before the team step, which finishes anyway ([leaving](permissions.md#leaving-a-group)). Once it has finished, the caller is out of the team, so sending it again gets `NOT_A_MEMBER`: treat that as done |

`counterpart` is required for `employer` and `pair` groups. It creates the second member, always as a placeholder ([D-016](decisions.md)). These groups always have exactly these two members; adding another returns `VALIDATION_FAILED`. Removing one with `DELETE /groups/{id}/members/{memberId}` also returns `VALIDATION_FAILED`; archive the group instead. `currency` cannot change after the group's first transaction (`VALIDATION_FAILED`).

When `POST /groups` leaves them out, `currency`, `timezone` and `region` come from the creator's profile, and `settings` takes its defaults ([data model](data-model.md#groups)). In a house, a member who isn't an admin can add people only with the default role.

Archiving clears `nextCloseAt`, so no more statements are drafted, until an admin unarchives the group (below). A `personal` group can't be archived (`VALIDATION_FAILED`). Nor can a group with a timer running in it (`CONFLICT`): stop or void the timer first, since one in an archived group can't be stopped. Nor can a group with a statement being finalized (`CONFLICT`): finalize it again first, since a finalize can't finish in an archived group. Only an account deletion archives a group over a finalize stuck for an hour ([a stuck finalize](identity-and-invites.md#each-group-they-joined)).

**Unarchive** makes the group writable again from today, and writes nothing in its past itself ([#428](https://github.com/rojinc/ledgerly/issues/428)). Afterwards, as after any outage, scheduler step 2 posts the archived weeks' occurrences that post themselves (autopay bills, and recurring expenses and income) from the last 7 days, on their own dates; older ones wait for someone to post or void them ([step 2](scheduling.md#step-2-auto-post)). The caller must be a joined admin (`requireMember` with `allowArchived`), so a member or viewer gets `FORBIDDEN` and a placeholder or someone who left `NOT_A_MEMBER`. A group that isn't archived comes back unchanged, so a retry is safe. A group whose delete has started (`deletingAt` set, [account](#account)) answers `CONFLICT`, writing nothing. Otherwise one database transaction stages `{ archivedAt: null, nextCloseAt }` on the group row, with `nextCloseAt` worked out from today, as for a cycle change (`null` with cycle `none`; [periods](statements.md#periods)). It then reads the group again (another unarchive that got there first answers `CONFLICT`, try again, so the retry returns the stored group, and a delete that got there first answers `CONFLICT` too) and writes a `group.unarchived` activity row that names no one, as `group.archived` does. It writes no transaction, share or `balances` row. A group that account deletion archived has no joined admin left ([each group they joined](identity-and-invites.md#each-group-they-joined)), so only someone added to it as an admin who joins it later can unarchive it, as any admin can (an archived group can be joined), and the last person in it can delete it ([#486](https://github.com/rojinc/ledgerly/issues/486)). The deleted person stays a former member, and the deleted-people rules still apply ([ledger](#ledger)). Schedules that step 1 stopped while it was archived stay stopped until they're restarted, edited or ended ([step 1](scheduling.md#step-1-expand-due-schedules)). A timer left running in it (account deletion can leave the deleted person's own: [changes after the checks](identity-and-invites.md#each-group-they-joined)) can be stopped again by whoever started it, and voided by an admin. A deleted person's can only be voided, since `/timer/stop` is the starter's own.

## identity

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /bootstrap` | `{ timezone }` | `{ profile, personId, personalGroupId, linkedGroupIds }` | the user; idempotent |
| `PATCH /profile` | `{ displayName?, timezone?, region?, currency?, business?, invoicePrefix?, summaryFrequency?, hoursCap?, emailOptOuts? }` | `profile` | the user |
| `POST /claim` | none | `{ linkedGroupIds: string[] }` | the user |
| `POST /invites` | `{ groupId, memberId, email?, phone? }` (exactly one) | `{ sentAt, expiresAt }` | anyone who may add members ([permissions](permissions.md)), with a verified email; only to a `placeholder` member ([invites](identity-and-invites.md#invites)); email only until SMS invites (#40): a `phone` gets `VALIDATION_FAILED`, "Invites by text message are not available yet." |
| `POST /invites/accept` | `{ token }` | `{ groupId }` or `{ needsVerification: 'email' \| 'phone' }` | signed-in user |
| `POST /reminders` | `{ id, groupId, email }` | `{ sentAt }` | a joined admin or member of a `pair` group, with a verified email, whom the other member owes ([reminders](identity-and-invites.md#reminders)); email only until SMS reminders (#40) |
| `GET /groups/pending` | none | `{ groups: { id, type, name, archivedAt, counterpartName? }[] }` | the user |
| `POST /` | the Appwrite user, as the event sends it; none for a scheduled run | `{}`; a scheduled run returns `{ unfinished, finished, skipped, cutOff, stopped, notices }` | only `identity`'s own runs, below; a signed-in call gets `FORBIDDEN` |
| `POST /groups/{id}/join` | none | `{ group, member }` | the user |

**`POST /` is one route for two kinds of run**, and it dispatches on the kind:
- a [scheduled run](permissions.md#function-side-checks) (`ctx.scheduled`), every 60 minutes (`interval: 60`), carries on unfinished merges ([finishing merges](identity-and-invites.md#finishing-merges)), then retries change notices that didn't go out ([change notice](identity-and-invites.md#email-and-phone-change-notice), step 8: `notices: { retried, failed, expired, gone }`), and returns `{ unfinished, finished, skipped, cutOff, stopped, notices }` ([finishing merges](identity-and-invites.md#finishing-merges), step 6, says what each counts);
- an [event run](permissions.md#function-side-checks) (`ctx.event`) of `users.*.update.password` or `users.*.recovery.*.update` sends the [password notice](identity-and-invites.md#password-notice), and one of `users.*.update.email` or `users.*.update.phone` the [email and phone change notice](identity-and-invites.md#email-and-phone-change-notice).

A person calling `POST /` gets `FORBIDDEN`, and any other call without a JWT `UNAUTHENTICATED`.

`PATCH /profile` changes only the fields given; `business`, when given, replaces the stored business details as a whole. `hoursCap` is `{ minutes, period: 'week' | 'fortnight', startsOn? }`, a fortnight's `startsOn` being a Monday, and `null` clears it ([profiles](data-model.md#profiles)); it only warns the user (F-82), never refuses a shift. `emailOptOuts` is the list of emails to turn off, any of `billDue`, `shiftToConfirm`, `transactionChanged` and `statementReady` ([#431](https://github.com/rojinc/ledgerly/issues/431)). It replaces the stored list as a whole, `[]` turns every email back on, and leaving it out keeps the list. An unknown type, a type twice or `null` is `VALIDATION_FAILED`.

An event run of `POST /` reads only the user ID, from the event's name in `x-appwrite-event` (a missing or any other name gets `FORBIDDEN`), and which event ran, from the end of that name; a change event also checks it against the body's `$id` ([change notice](identity-and-invites.md#email-and-phone-change-notice)). It never logs or stores the body (Appwrite's user model can carry the password hash), and answers `{}` to an event run whether it sent an email or not (a failed send fails the run).

`linkedGroupIds` (`/bootstrap`, `/claim`) lists only the groups joined in that call, so after a retry it leaves out groups an earlier, interrupted call already joined.

`/groups/pending` and `/join` are how someone who already had an account when they were added joins a group ([Joining a group](identity-and-invites.md#joining-a-group)). Both act only on the caller's own person:

- `/groups/pending` lists the groups where that person is a `placeholder` member (`members.idx_person_status`), archived ones included. For a `pair` group it adds `counterpartName`, the other member's display name: the group's own `name` is what its creator calls the caller. Nothing else about the other member is returned, never an email or phone.
- `/join` reads the caller's member row in that group first, so someone who isn't in the group learns nothing about it; with no row it returns `NOT_A_MEMBER`. It then runs the steps in [Joining a group](identity-and-invites.md#joining-a-group): team first, then `active` (or `left` if `leftOn` is set) with a `member.joined` row. If the row is already `active`, or `left` for someone who moved out (still in the team), it returns `{ group, member }` unchanged and doesn't touch the team, so a retry is safe. Someone who left on their own (`left`, no longer in the team) gets `NOT_A_MEMBER`: coming back after leaving isn't supported in v1. If the join fails while the row is still `placeholder`, the team membership from the first step is taken back. Joining writes no ledger data, so it works on archived groups, the same as claim and accepting an invite (sending one gets `ARCHIVED`), but not on a group being deleted (`deletingAt` set, [deleting a group](identity-and-invites.md#deleting-a-group)), which answers `NOT_A_MEMBER` as for a team that's gone.

Details: [People, identity and invites](identity-and-invites.md).

## account

Deleting an account ([#50](https://github.com/rojinc/ledgerly/issues/50)), and an archived group nobody else is in ([#429](https://github.com/rojinc/ledgerly/issues/429)). A function of its own, so `identity` never holds `users.write` or file access.

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /delete` | `{ confirm: 'DELETE' }` | `{ deletedAt, finished }` | the user, signed in within the last 10 minutes |
| `POST /groups/{id}/delete` | `{ confirm: 'DELETE' }` | `{ finished }` | the last person in an archived group's team: its admin, or anyone once it has no joined admin ([#486](https://github.com/rojinc/ledgerly/issues/486)); signed in within the last 10 minutes |

Every 60 minutes (`interval: 60`), sent as `POST /` with the `schedule` trigger: it finishes account deletions (persons with `deletedAt` and `userId` both set, and Appwrite users labelled `deleted`), then group deletes (groups with `deletingAt` set), then deletes the end-to-end flows' accounts (Appwrite users labelled `e2e` whose email is a run's test address), skipping any started or labelled in the last minute ([finishing purges](identity-and-invites.md#finishing-purges)). It returns `{ finished, users, groups, e2e, failed }`: the account deletions it finished, the labelled users it deleted, the group deletes it finished, the end-to-end accounts it deleted, and those that failed (each logged by its ID). A person calling `POST /` gets `FORBIDDEN`.

**`POST /delete`** deletes the caller's account ([deleting an account](identity-and-invites.md#deleting-an-account-m4)). It is synchronous and works for up to 20 seconds; `finished: false` means the hourly job deletes the rest. Refusals change nothing, and are checked in this order:

| Code | When |
| --- | --- |
| `VALIDATION_FAILED` | The body isn't `{ confirm: 'DELETE' }` |
| `NOT_FOUND` | No person names the caller, as for identity's routes: "Set up your account first." |
| `FORBIDDEN`, `details: { reason: 'reauth' }` | The caller's session (from the JWT's session ID, loaded with `users.listSessions`) was created more than `REAUTH_WINDOW_MINUTES` (10) ago, or can't be found. The app asks them to sign in again and retries. |
| `FORBIDDEN`, `details: { reason: 'recent_password_change' }` | The user's `passwordUpdate` is less than `RECENT_PASSWORD_CHANGE_HOURS` (24) old. The app says when they can try again. |
| `CONFLICT` | They have a timer running in a group that isn't archived |
| `CONFLICT` | A statement is being finalized in a group where they're the only joined admin: "A statement is being finalized. Finish it first." |
| `VALIDATION_FAILED`, `details: { groupIds }` | They're the only joined admin of a house that isn't archived and has another `active` member. Here `details` names the houses, not schema issues. |
| `CONFLICT` | Another write to their person landed while step 2 set `deletedAt` (an invite's guard write, say): "Something else changed this at the same time. Try again." |

A call after `deletedAt` is set skips the checks (apart from the body) and carries on, since the account is already going. The caller's sessions are deleted right after, so a retry from the app gets `UNAUTHENTICATED`. That doesn't prove the deletion finished: the app asks the user to sign in again, which fails once their account is gone. The types are `deleteAccountBodySchema`, `DeleteAccountResult` and `DeleteAccountRefusal` in `packages/core/src/schemas/identity.ts`.

**`POST /groups/{id}/delete`** deletes an archived group nobody else is in, with everything in it ([deleting a group](identity-and-invites.md#deleting-a-group)): the [purge](identity-and-invites.md#purging-a-group) an account deletion runs for such a group. It is synchronous and works for up to 20 seconds; `finished: false` means the hourly job deletes the rest. Refusals change nothing, and are checked in this order:

| Code | When |
| --- | --- |
| `VALIDATION_FAILED` | The body isn't `{ confirm: 'DELETE' }` |
| `NOT_A_MEMBER` | `requireMember` with `allowArchived` ([function-side checks](permissions.md#function-side-checks)): no member row, a placeholder, someone who left on their own, or a person being deleted; or someone who moved out, once the group's delete has deleted the team |
| `FORBIDDEN` | The caller isn't an admin, and the group has a joined admin: a member row with `role` `admin` and `status` `active` ([#486](https://github.com/rojinc/ledgerly/issues/486)) |
| `FORBIDDEN`, `details: { reason: 'reauth' }` | As for `POST /delete`: the caller's session was created more than `REAUTH_WINDOW_MINUTES` (10) ago, or can't be found ([refusals](identity-and-invites.md#refusals), 2) |
| `FORBIDDEN`, `details: { reason: 'recent_password_change' }` | As for `POST /delete`: the user's `passwordUpdate` is less than `RECENT_PASSWORD_CHANGE_HOURS` (24) old ([refusals](identity-and-invites.md#refusals), 3) |
| `VALIDATION_FAILED` | A `personal` group, or a group that isn't archived |
| `VALIDATION_FAILED`, `details: { reason: 'shared' }` | Anyone else is in the group's team, someone who moved out included. Here `details` gives the reason, not schema issues. |
| `CONFLICT` | Another write to the group landed while `deletingAt` was set (an unarchive, say): "Something else changed this at the same time. Try again." |

Then it sets `deletingAt` and `deletingBy` (the caller's person) with a fresh `rev`, deletes the team and purges the group, ending with `deletingBy`'s member row ([deleting a group](identity-and-invites.md#deleting-a-group)). A call once `deletingAt` is set skips the session, password and group checks and carries on, since the group is already going. A caller whose row is `active` (an admin, or a member or viewer of a group with no joined admin) still passes the membership check after the team is gone: `requireMember` checks the team only for a `left` row. A caller who moved out has a `left` row, so once the team is gone a later call of theirs gets `NOT_A_MEMBER` straight away: the app treats that as done, and the hourly job's group pass finishes the purge ([finishing purges](identity-and-invites.md#finishing-purges)). Once the purge has finished, the caller's row is gone, so a call gets `NOT_A_MEMBER`: treat that as done. A purge that loses a race with another purge of the group (the hourly job's, or the caller's own account deletion's) answers `finished: false`, not an error. The types are `deleteGroupBodySchema`, `DeleteGroupResult` and `DeleteGroupRefusal` in `packages/core/src/schemas/identity.ts`.

## scheduler

Every 60 minutes (`interval: 60`), sent as `POST /` with the `schedule` trigger. A person calling `POST /` gets `FORBIDDEN`, and a call without a JWT `UNAUTHENTICATED`. HTTP routes:

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /schedules` | `ScheduleInput` | `{ schedule, created: number }` | admin; house members for their own |
| `PATCH /schedules/{id}` | `ScheduleInput` (same `id`) | `{ schedule, created, updated, removed }` | creator or admin |
| `POST /schedules/{id}/end` | `{ endsOn: LocalDate }` | `{ schedule, removed }` | creator or admin |
| `POST /schedules/{id}/pause` | `{ pausedFrom: LocalDate }` (local today or later) | `{ schedule, removed }` | creator or admin |
| `POST /schedules/{id}/resume` | none | `{ schedule, created }` | creator or admin |
| `DELETE /schedules/{id}` | none | `{}` | creator or admin; no posted occurrences |
| `POST /schedules/preview` | `ScheduleInput` without `id` + `{ count?: number }` (1–100, default 10) | `{ dates: LocalDate[], skipped: { date, reason: 'exdate' \| 'holiday' }[] }` | any member; not in an archived group |

```ts
type ScheduleInput = {
  id: string                    // ID.unique(), exactly 20 chars (occurrence IDs append _YYYYMMDD)
  groupId: string
  kind: 'shift' | 'bill' | 'expense' | 'income'
  description: string
  template: Omit<TransactionInput, 'id' | 'groupId' | 'date' | 'kind' | 'description' | 'receiptFileIds'>
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

Every 60 minutes (`interval: 60`; Appwrite calls `POST /`, and only a scheduled run may). Each run drafts the periods that are due, then emails the invoices with lines it auto-finalized in groups with `autoSend` on ([auto-send](statements.md#auto-send)). It returns `{ drafted, failed }`: the groups it drafted a statement for, and those whose draft failed (each logged). The emails aren't counted. HTTP routes:

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /statements/preview` | `{ groupId, periodEnd?: LocalDate }` | `{ snapshot }` (not saved; the period is a close's) | any member |
| `POST /statements/close` | `{ groupId, periodEnd?: LocalDate }` | `statement` (the new draft, or the unfinished one a retry asks for) | admin; employer and house only |
| `POST /statements/{id}/refresh` | none | `statement` | any member; drafts only |
| `POST /statements/{id}/finalize` | `{ send: boolean }` | `statement` (call **async**) | admin |
| `POST /statements/{id}/send` | none | `{ sentAt }` | admin; final only |
| `POST /statements/{id}/void` | `{ reason }` | `statement` | admin; latest final only |
| `POST /statements/{id}/discard` | none (`emptyBodySchema`) | `{}` | admin; drafts only |
| `POST /statements/reissue` | `{ groupId, periodStart, periodEnd }` | `statement` (draft) | admin |

On the five `/statements/{id}/…` routes, a caller who isn't a member of the statement's group gets `NOT_FOUND`, the same answer as for an ID that doesn't exist, as on the ledger's ID routes.

`/discard` deletes the draft ([§5](statements.md#5-discard-post-statementsiddiscard)), so calling it again gets `NOT_FOUND`. The app treats that as done.

`/close` drafts the period so far without waiting for the job, and asking again with the same `periodEnd` returns the same draft ([§6](statements.md#6-close-a-period-now-post-statementsclose)).

Details: [Statements and invoices](statements.md).

---

## Function code layout

```
functions/<name>/
  src/main.ts           <name>Routes(services), the route list; export default createHandler(<name>Routes(servicesFromRequest))
  src/services.ts       the Appwrite services, email and clock the routes use, so tests can pass fakes; servicesFromRequest builds the real ones
  src/routes/<route>.ts a route's handler (identity's pending-groups.ts holds two), and helpers it exports to other routes
                        or the job (claim.ts, finalize.ts, send.ts); routes/auto-send.ts is only helpers (finalize and the job)
  src/steps/<step>.ts   scheduler only: one file per job step
  src/<file>.ts         code several routes share, and one-off backfills that scripts/ runs
  test/<topic>.test.ts  by route or topic, with fake services
  test/harness.ts       the fixed clock, fixtures and fakes the tests share
```

The body schemas aren't in `functions/`: each route parses its body with its schema from `packages/core/src/schemas/` ([validation](#validation)), one file per function (`account`'s are in `identity.ts`), and `emptyBodySchema` in `common.ts`.

`createHandler` (in `packages/server`) does the routing by method and path, verifies the caller's JWT ([permissions step 1](permissions.md#function-side-checks)), turns `AppError` into the envelope above and logs one structured line per request (no personal data).
