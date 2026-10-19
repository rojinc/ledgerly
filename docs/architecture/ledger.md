# The ledger

This is the money model. Every module (employer, house, personal, lend/borrow) uses it. Read this page before touching anything that creates, changes or shows an amount.

The code for everything here lives in `packages/core` as pure functions with tests. Functions and apps call those functions; they never re-implement the maths.

## Concepts in one minute

- A **group** has **members** (people).
- A **transaction** is one event: a shift, an expense, a bill, a payment and so on.
- When a transaction is **posted**, it gets one **share** per person involved.
- A share records what that person **gave** (`givenCents`) and **received** (`receivedCents`).
- **Net** = given − received. A person's **balance** in a group is the sum of their nets.
- Positive balance: the group owes you. Negative: you owe the group.

This is the same idea as Splitwise's "paid share / owed share". We use *given* and *received* because the words fit shifts and payments as well as purchases.

## Invariants

These must hold for every posted transaction, always. `packages/core` exports `assertShareInvariants()`; the `ledger` function calls it before every write, and a nightly job re-checks production (M4).

1. **I-1 Balanced:** Σ `givenCents` = Σ `receivedCents` = `totalCents`. So the nets in a transaction always add up to 0.
2. **I-2 Integers:** every amount is an integer number of cents. No floats are ever stored.
3. **I-3 Members only:** every share's person has a `members` row in the transaction's group, whatever its status. Placeholders and people who have left count. Join and leave dates don't limit who can be in a transaction: a bill paid after someone moved out, a settle-up from a former housemate and a back-dated entry are all valid. The dates only decide `days` weights ([Days present](#days-present)) and who a house's [default split](#default-split) includes.
4. **I-4 One sign:** for a normal transaction every amount is ≥ 0. For a refund (`totalCents` < 0) every amount is ≤ 0. Signs are never mixed within one transaction, except in `adjustment`. Only `expense`, `bill` and `adjustment` can have a negative total.
5. **I-5 One share per person:** at most one share per person per transaction.
6. **I-6 Only posted counts:** only `posted` transactions have shares. `scheduled`, `running`, `due` and `void` transactions have none.
7. **I-7 Locked is final:** a transaction with a `statementId` pointing at a final statement is never changed or voided. One exception: a [person merge](identity-and-invites.md#merging-two-persons) repoints its shares from the merged placeholder to the person it was merged into, combining their two shares into one where both had one (I-5). The transaction's total, and every other person's share, stay the same.

## Transaction kinds

| Kind | Allowed in | Who gives | Who receives | Notes |
| --- | --- | --- | --- | --- |
| `shift` | employer | worker: amount | employer: amount | amount = `round(minutes × rateCents / 60)`. The worker is the group owner. |
| `expense` | all | payers | split (or items) | Purchases, groceries, employer-related spending |
| `bill` | house, personal, pair | payers | split ([default](#default-split) `days` in a house) | Has a billing period and due date. `due` until paid. |
| `payment` | all except personal | `fromPersonId`: total | `toPersonId`: total | Money moving between members: settle-ups, employer paying you, loan repayments |
| `loan` | pair, house | lender: total | borrower(s): split | An expense with a different label in the UI |
| `income` | personal | you: total | you: total | Recorded for reports; net 0 |
| `adjustment` | all | explicit | explicit | Shares given directly. Needs a reason. The only way to correct locked history. |

### Employer presets

Employer expenses are ordinary `expense` transactions. The UI offers presets so nobody has to think in shares:

| Preset | payers | split | Effect |
| --- | --- | --- | --- |
| I paid for them (reimbursable) | worker | employer | Employer owes worker more |
| Bought on their card, for work | employer | employer | Net 0; listed on the invoice for transparency |
| Personal, on their card / cash advance | employer | worker | Employer owes worker less |

## Worked examples

| Event | Shares (given / received) | Nets |
| --- | --- | --- |
| Electricity $90, Alice paid, split equally between 3 | Alice 9000/3000 · Bob 0/3000 · Cara 0/3000 | Alice +6000, Bob −3000, Cara −3000 |
| Bob pays Alice $30 | Bob 3000/0 · Alice 0/3000 | Bob +3000, Alice −3000 |
| Thursday shift 5h × $25 | Worker 12500/0 · Employer 0/12500 | Worker +12500, Employer −12500 |
| Employer pays $500 | Employer 50000/0 · Worker 0/50000 | Employer +50000, Worker −50000 |
| $120 on employer's card for work | Employer 12000/12000 | 0 |
| Lend Sam $50 | You 5000/0 · Sam 0/5000 | You +5000, Sam −5000 |
| Refund of $20 on a shared $60 purchase Alice paid (split Alice/Bob) | Alice −2000/−1000 · Bob 0/−1000 | Alice −1000, Bob +1000 |

## Statuses

```
             ┌─────────────┐
 schedule ──►│  scheduled  │──post──┐
             └─────────────┘        │
 timer start ┌─────────────┐        ▼
 ───────────►│   running   │──stop──► posted ──(final statement)──► locked
             └─────────────┘        ▲     │
 new bill    ┌─────────────┐        │     └──void──► void
 ───────────►│     due     │──pay───┘
             └─────────────┘
 anything not yet locked ──void──► void   (row kept; shares deleted)
```

- `scheduled`: created by a schedule for a future or current date. Shown dashed on the calendar.
- `running`: a timer shift that has started but not stopped. `startedAt` is set.
- `due`: a bill waiting to be paid. Shown dashed until paid.
- `posted`: real and counted. Has shares.
- `void`: cancelled. Kept for history and so schedules don't re-create it. Has no shares.

*Locked* is not a status. It means `statementId` is set by a final statement.

## Splits

A **split spec** says how an amount is divided. It is stored in the transaction's `inputJson`, so the UI can show and edit it exactly as the user entered it. Shares are always rebuilt from it.

```ts
type SplitSpec =
  | { mode: 'equal';   personIds: string[] }
  | { mode: 'exact';   amounts: { personId: string; cents: number }[] }        // must sum to the amount
  | { mode: 'percent'; percents: { personId: string; basisPoints: number }[] } // 10000 = 100%; must sum to 10000
  | { mode: 'weights'; weights: { personId: string; weight: number }[] }       // positive integers
  | { mode: 'days';    personIds?: string[] }                                  // bills only; default: everyone present in the period
```

### Default split

When an expense, bill or loan names no split and has no items:

- an **employer** group has no default: the request must pick a [preset](#employer-presets),
- a **bill in a house** with a billing period uses the group's `defaultBillSplit`: `days`, or, if the group set `equal`, an equal split between the members with at least one day in the period (the same people `days` would pick),
- otherwise it is split equally. In a house that means everyone present on the date (`joinedOn` ≤ date ≤ `leftOn`); in a personal or pair group it means every member, because there `joinedOn` is only the day someone was added and back-dated entries are normal,
- a **loan** leaves out the payers, so it goes to the borrowers.

Default splits, and `days` splits without `personIds`, list members by `personId`, so leftover cents go in that order. If that leaves nobody, the request fails with `VALIDATION_FAILED`.

### Days present

For a bill with period `[periodStart, periodEnd]`, each member's weight is the number of days in that period between their `joinedOn` and `leftOn` (inclusive). Members with 0 days are left out. If everyone has 0 days, or the period is longer than 10,000 days (the weight limit), the request fails with `VALIDATION_FAILED`.

Example: period 1 Jul–30 Sep (92 days). Alice and Bob were there all along (92 each); Cara moved in 1 Aug (61). Weights are 92 : 92 : 61.

## Allocation and rounding

Every split ends with `allocate(totalCents, weights)`:

1. Give each person `floor(total × weight / Σweights)`.
2. Hand out the leftover cents one at a time, largest fractional remainder first. Ties go to whoever comes first in the spec, so the result is deterministic.
3. For negative totals, allocate the absolute value and flip the sign.

The result always sums to exactly `totalCents`. Example: `allocate(1000, [1, 1, 1])` → `[334, 333, 333]`.

Limits (constants in `packages/core`): every amount is at most `MAX_AMOUNT_CENTS` = 10,000,000,000 ($100M) in size, and each weight is an integer from 0 to 10,000 (a `weights` split needs at least 1). So `total × weight` stays far below `Number.MAX_SAFE_INTEGER` and step 1 is exact. The zod schemas reject anything larger.

Other rounding rules:

- Shift amount: `Math.round(minutes × rateCents / 60)`, so half a cent rounds up.
- Statement and report totals are **sums of stored amounts**, never recalculated from hours × rate. So PDFs always add up.

## Payers

`payers: { personId, cents }[]` says who gave money and must sum to the total. When a new transaction gives none, the caller pays everything; an edit without payers keeps who paid before ([functions API](functions-api.md#ledger)). Several payers are allowed (Alice paid $50 and Bob $40 of a $90 bill). Only expenses, bills and loans have payers; giving payers for any other kind fails.

## Items (itemised receipts)

- The transaction total equals the sum of item `amountCents` (items may be negative, such as discounts).
- Each item is allocated by its own split spec.
- A person's `receivedCents` is the sum of their parts of every item.
- The final per-person amounts must still meet invariant I-4. If a discount would push someone below 0, the request fails.
- Limits: at most **30 items** and **15 people** per transaction. That keeps any write under the Appwrite Free plan's 100 operations per transaction. See [Scaling](scaling.md#appwrite-limits-we-design-around).

## Building shares

`buildShares(input, context) → { totalCents, shares }` in `packages/core/src/ledger` is the only code that turns a transaction into its total and shares. The total comes from the input: `minutes × rate` for a shift, the sum of items, the sum of an adjustment's given amounts, or `totalCents`. With items or an adjustment, a `totalCents` in the input must match; a shift can't carry one ([Validation](functions-api.md#validation)). Outside adjustments, a total of 0 gives no shares. The `context` holds the group type, owner, caller (the default payer), members with join/leave dates and, for houses, `defaultBillSplit`. The function is pure: same input, same output, with shares sorted by `personId`.

Rules:

- Shares are **rebuilt completely** on every write, in one database transaction: every share row is rewritten whole from the new set, extra rows are created and rows left over are deleted. Never patch a single share. Items are rebuilt the same way. Rewriting rows instead of deleting and recreating them keeps the largest edit (15 people, 30 items) within one transaction's 90 writes.
- Each share copies `groupId`, `date`, `kind` and `category` from its transaction so the main queries need one index. Because shares are always rebuilt, these copies can't drift. ([D-007](decisions.md))
- A person whose given and received are both 0 (for example 1 cent split three ways) gets no share row.

Rule-breaking input fails with `VALIDATION_FAILED`: payers or exact amounts that don't add up, a discount that pushes someone below 0, a kind the group type doesn't allow, a person who isn't a member, a total over `MAX_AMOUNT_CENTS`, a negative total on a kind that can't be a refund, or more than 15 people. A broken group (an employer group without exactly one employer) and a failed `assertShareInvariants()`, which runs afterwards as a last guard, are bugs and fail with `INVARIANT_VIOLATION`.

## Balances

- **Group balance per person** = Σ (`givenCents` − `receivedCents`) over that person's shares in the group.
- **Employer balance due** = the worker's balance in the employer group (equal to minus the employer's).
- The **dashboard** shows each group's balance for the user.

v1 works balances out on read. When that gets slow, the `ledger` function will maintain a `balances` table inside the same transaction (M4). See [Scaling](scaling.md).

## Settle up (suggested transfers)

`suggestTransfers(nets) → { fromPersonId, toPersonId, cents }[]`:

1. Drop people with net 0.
2. Sort creditors (net > 0) by amount, largest first, and debtors (net < 0) by size, largest first. Ties are broken by `personId`, so output is deterministic.
3. Match the largest debtor with the largest creditor and transfer the smaller of the two amounts. Reduce both and drop anyone who reaches 0. Repeat, picking the largest remaining debtor and creditor again each round (same tie rule).

`netsFromShares(shares)` gives the nets: one `{ personId, netCents }` per person with shares, sorted by `personId`. If the nets aren't whole cents, one per person, adding up to 0, `suggestTransfers` throws, because the stored shares are broken.

This gives at most n − 1 transfers. It works **within one group only**. We never net across groups, because that would leak one group's data into another.

## Reports

All reports are sums over the user's shares in groups they have joined ([D-016](decisions.md)). Nothing is copied into the personal group.

| Report | Formula (for person P, date range R) |
| --- | --- |
| My spending | Σ `receivedCents` where kind ∈ {expense, bill}, by category |
| Earnings | Σ `givenCents` where kind = shift |
| Money received | Σ `receivedCents` where kind = payment (includes settle-ups and loan repayments) |
| Income (F-54) | Σ `receivedCents` where kind = payment in `employer` groups, plus personal income |
| Money paid out | Σ `givenCents` where kind ∈ {expense, bill, payment, loan} |
| Personal income | Σ `totalCents` of `income` transactions in P's personal group |
| Owed to me / I owe | per-group balances, positive and negative |

`buildPersonalReport(personId, shares, groups)` in `packages/core/src/reports/personal-report.ts` computes every row but the last, one set per currency; `reportByMonth()` does the same for each month, taken as `date.slice(0, 7)` of the local-date text. Callers pass P's shares with their copied `kind`, `category` and `date`. A few details:

- Personal income is Σ `receivedCents` of P's `income` shares in the personal group. By [I-1](#invariants) that equals Σ `totalCents` of those transactions, so no transaction rows are needed.
- Spending with no category is reported under `none`, never `other`.
- Refunds reduce the totals. A share whose group wasn't passed in throws, because dropping it would hide money.
- Owed to me / I owe stays with the balances (`settle/` and `GET /groups/{groupId}/balances`).

## Editing and voiding

- **Edit**: replace the transaction's input. Shares and items are rebuilt and an activity row records before and after. Allowed until the transaction is locked.
- **Void**: set status `void`, delete shares and keep the row. Allowed until locked.
- **Locked**: create an `adjustment` instead. It shows on the next statement.
- Editing a schedule-generated occurrence sets `overridden = true`. See [Scheduling](scheduling.md).

## Concurrency

Every ledger write checks what it depends on only after staging a write to it in its database transaction ([conventions](../engineering/conventions.md#functions)). A change by anyone else after that makes the commit fail with 409 (a delete fails it with 404, which `withTransaction` reports as 409), and the write runs once more from the start.

- **The transaction row:** edit, post and void stage a write to it first, then read it, its shares, items and stored input. So they never act on a version that another edit, post, void or lock (I-7) has replaced.
- **The member rows (I-3):** every create, edit and post stages a guard write to the `members` row of each person the transaction names (payers, splits, items, payment, adjustment) or gives a share, then reads it and checks it still belongs to that person (a [merge](identity-and-invites.md#merging-two-persons) gives a member row to another person). This includes a `due` or `scheduled` transaction, which has no shares yet, and a schedule's template ([scheduling](scheduling.md#schedule-routes)): creating or editing a schedule, and each batch of occurrences it creates, guard the same rows. A member removed meanwhile can't be left with a share, or named in a transaction that would give them one when it's posted. The `groups` function refuses to remove anyone an unposted transaction names, so the two checks together cover both orders.
- **The group row:** every create, edit, post and void stages a guard write to the group row, then checks that its currency, archive date, time zone and settings are what the write read. A change to any of them that lands meanwhile makes the write run again with the group as it is now.
- **Person merges** write shares too ([merging](identity-and-invites.md#merging-two-persons), step 3). Each batch stages a guard write on the row of every group whose shares or inputs it changes, then checks that no statement in the group is `finalizing`, and leaves that group for later if one is. Its member-row writes (step 2) stage both rows before checking them, so a ledger write racing a merge runs again.
- **Receipt rows:** every write that adds or takes off a receipt reads the files' [`receiptFiles`](data-model.md#receiptfiles) rows first, stages its writes to them, then reads them again as committed (not through its transaction, which would show its own staged values) and runs again if any changed. So it never overwrites another write's change to `transactionIds`, and it sees a row the scheduler made or marked for deletion meanwhile ([step 5](scheduling.md#step-5-receipt-clean-up)).
- **Statements being finalized:** the `finalizing` check runs after the group row is staged. Finalize step 1 stages the group row in the same database transaction that sets `finalizing` ([statements](statements.md#2-finalize-post-statementsidfinalize)), so a write that checked just before then fails its commit, runs again and gets `LOCKED`.

A **guard write** sets the row's `rev` to a fresh random value ([data model](data-model.md#groups)). Appwrite counts only real changes when it checks a commit: a write that leaves a row as it was (a "no-op") neither fails anyone else's commit nor is noticed by them (checked on `ledgerly-dev`, #105). So the guard must change something, and `rev` exists only for that: writing it never undoes anyone else's change, and it makes the order work both ways. A member delete or currency change staged before a ledger write commits now fails its own commit, because the ledger's guard changed the row. Because every write guards the group row, two writes to the same group at the same moment are serialized: the second one's commit fails and it runs again.

## Currency

Each group has exactly one currency. Amounts in different currencies are never added together. Totals across groups are shown per currency.
