# Scaling

The aim: nothing we build now needs a rewrite at 100,000 users, and we don't build anything for scale before it's needed. Each item below says what we do **now** and what we do **when** a clear signal shows up.

## Appwrite limits we design around

| Limit | Value | How we handle it |
| --- | --- | --- |
| Operations per TablesDB transaction | Free 100 · Pro 1,000 · Scale 2,500 | At most 30 items and 15 people per transaction, so one write uses fewer than 100 operations. Bulk jobs (locking, merges) work in batches of 90. |
| Synchronous execution timeout | 30 seconds, hard | User-facing routes target under 2 s. Long work (finalize) runs async and is resumable. |
| Cron timing | UTC clock | Jobs run hourly and work out each group's local date themselves. |
| Pagination | Offset paging slows down on large tables | Always use cursor pagination (`Query.cursorAfter`), page size 100. A job that goes through rows which may be deleted meanwhile pages by `$id` instead (`Query.greaterThan('$id', last)` with `Query.orderAsc('$id')`), because a deleted cursor row fails the query. |

Production runs on the **Pro** plan. Development may use Free, which is why we keep under the Free limits.

### The ledger's write budget

The biggest single writes, with 15 people and 30 items:

| Write | Operations |
| --- | --- |
| `POST /transactions` | **64:** the group guard 1, member guards 15, the transaction 1, shares 15, items 30, the activity row 1, the `balances` row 1 |
| `PATCH /transactions/{id}` | **65:** the same, plus staging the transaction row before reading it ([concurrency](ledger.md#concurrency)) |

The planned `receiptFiles` rows (#163), one for each receipt a write adds or removes, add at most 10 to a create (**74**) and 20 to a `PATCH` that swaps 10 receipts for 10 others (**85**). All of these stay under the 90 that batch jobs use. A change that adds writes to these routes updates this table.

### The balances cache

The `balances` cache ([ledger](ledger.md#balances)) is **one row per group**, with everyone's balance in its JSON, and not one row per person:
- A per-person row's ID would be `<groupId>_<personId>`, 41 to 57 characters, and Appwrite IDs allow 36.
- A `PATCH` that moves a split from 15 people to 15 others would write 30 rows, for 64 + 30 = 94 operations, over 90.
- A missing per-person row couldn't tell "no shares" from "not built". A missing group row only ever means the second: not built yet, or deleted until the nightly check builds it again.

The JSON holds one entry for each person who has a share in the group: tens of entries, far under `mediumtext`'s 16 MB.

## Problems and fixes

| Problem at scale | Now | When the signal appears |
| --- | --- | --- |
| The scheduler loops over every user | Not an issue: it only queries `schedules` with `nextRunAt <= now` (indexed) and `groups` with `nextCloseAt <= now`. Work grows with what is **due**. | If one run can't finish the due work within the hour, run the cron every 15 minutes, then split by schedule kind into separate functions. |
| Balances are summed on every dashboard load | A `balances` row per group, kept by every write of shares in its own transaction. `GET /balances` reads that one row, and the scheduler's [nightly check](scheduling.md#step-6-nightly-check) compares it with a fresh sum ([ledger](ledger.md#balances)). | Nothing more needed. Clients didn't change. |
| The nightly check reads every group's shares again each day | Step 6 reads each due group whole once a day, in what's left of the hourly runs' budget. Work grows with all shares, not with what changed. | When step 6 can't check every due group within a day's runs (groups still due after 24 hours): skip a group whose `rev` hasn't changed since its last finished check (an additive `groups.checkedRev`). |
| A merge reads all of P's groups | Merge step 3 reads every transaction in P's groups, locked ones included, from the start on every claim and hourly run ([merging](identity-and-invites.md#merging-two-persons)) | The same merge logs "carries on next claim" with 0 inputs on several claims in a row. Then keep a resume point per merge (an additive `persons` column), or move each group's shares as soon as its inputs are done. |
| Finding unfinished merges walks every merged person | `identity`'s hourly job pages through all persons with `mergedInto` set, finished merges included, 2 reads per 100 ([finishing merges](identity-and-invites.md#finishing-merges)) | The walk takes more than about 1 s of the run's budget. Then add an indexed `persons.mergingSince`, set in step 1 and cleared once P has no identity, and walk only those. |
| Long history lists | Cursor pagination, filtered by date range | Nothing more needed. |
| Slow queries | An index exists for every query in [data model](data-model.md) | Any new query in a PR must name the index it uses. |
| Duplicate writes from retries or bad mobile networks | Client-generated IDs; deterministic occurrence IDs | Nothing more needed. |
| Receipt storage cost | Client resizes images to at most 1600 px and WebP before upload; 10 MB cap | Clean up unattached files (M4). Add lifecycle rules if storage costs matter. |
| Data grows forever | Closed periods never change; reports read statements for old periods | Archive shares and transactions older than N years to cold storage. Not before 2028. |
| Realtime fan-out | One subscription per signed-in app for the tables it reads. The activity feed has no channel of its own: every activity row is written with a row of one of those tables, whose event refreshes it. Appwrite sends only rows the user can read, and only queries on screen refetch. | Nothing more needed for groups of under 20 people. |
| Email volume | Resend | Separate transactional and summary sending streams. |
| Very large data (hundreds of millions of shares) | Every money write already goes through one function | Move the ledger tables to a dedicated Postgres behind the same function API. Clients don't change. |

## Rough sizing

Assume 100k users, 2.5 groups each, about 40 posted transactions per user per month, and 2.5 shares per transaction:

- about 4M transactions and 10M shares per month,
- about 120M share rows per year.

Indexes keep every user-facing query bounded (one group, one date range), so table size mostly costs storage, not speed. This is the number to watch on the Appwrite plan, and the reason the ledger sits behind one function API.

## Performance budgets

| Action | Budget (p95) |
| --- | --- |
| Open calendar month | < 800 ms |
| Create or edit a transaction (function round trip) | < 1.5 s |
| Open a draft statement (refresh) | < 2 s |
| Finalize a statement | < 20 s (async) |

The web app uses optimistic updates (TanStack Query) so writes feel instant.
