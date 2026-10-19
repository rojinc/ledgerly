# Scaling

The aim: nothing we build now needs a rewrite at 100,000 users, and we don't build anything for scale before it's needed. Each item below says what we do **now** and what we do **when** a clear signal shows up.

## Appwrite limits we design around

| Limit | Value | How we handle it |
| --- | --- | --- |
| Operations per TablesDB transaction | Free 100 · Pro 1,000 · Scale 2,500 | At most 30 items, 15 people and 10 receipts per transaction, so one write uses fewer than 100 operations (the largest, a `PATCH` that changes them all, uses 84). Bulk jobs (locking, merges) work in batches of 90. |
| Synchronous execution timeout | 30 seconds, hard | User-facing routes target under 2 s. Long work (finalize) runs async and is resumable. |
| Cron timing | UTC clock | Jobs run hourly and work out each group's local date themselves. |
| Pagination | Offset paging slows down on large tables | Always use cursor pagination (`Query.cursorAfter`), page size 100. A job that goes through rows which may be deleted meanwhile pages by `$id` instead (`Query.greaterThan('$id', last)` with `Query.orderAsc('$id')`), because a deleted cursor row fails the query. |

Production runs on the **Pro** plan. Development may use Free, which is why we keep under the Free limits.

## Problems and fixes

| Problem at scale | Now | When the signal appears |
| --- | --- | --- |
| The scheduler loops over every user | Not an issue: it only queries `schedules` with `nextRunAt <= now` (indexed) and `groups` with `nextCloseAt <= now`. Work grows with what is **due**. | If one run can't finish the due work within the hour, run the cron every 15 minutes, then split by schedule kind into separate functions. |
| Balances are summed on every dashboard load | Sum shares on read inside `GET /balances` | When p95 of `/balances` goes over 500 ms: add a `balances` table (`groupId`, `personId`, `netCents`), updated by `ledger` in the same transaction as the shares, plus a nightly job that checks it against a fresh sum. Clients don't change. |
| Long history lists | Cursor pagination, filtered by date range | Nothing more needed. |
| Slow queries | An index exists for every query in [data model](data-model.md) | Any new query in a PR must name the index it uses. |
| Duplicate writes from retries or bad mobile networks | Client-generated IDs; deterministic occurrence IDs | Nothing more needed. |
| Receipt storage cost | Client resizes images to at most 1600 px and WebP before upload; 10 MB cap. The scheduler deletes files that no transaction lists after 24 hours ([step 5](scheduling.md#step-5-receipt-clean-up)); the work grows with the uploads of the last 72 hours and the files that are due, not with total storage. | Add lifecycle rules if storage costs matter. |
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
