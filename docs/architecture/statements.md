# Statements and invoices

A **statement** summarises a group for a period and then locks that period. The same code produces:

- **Invoices** for `employer` groups: what the employer owes you, as a PDF emailed to their billing address.
- **Monthly divides** for `house` groups: who paid what, everyone's share and who should pay whom.

`personal` and `pair` groups have no statements (`statementCycle = none`).

## Core rules

1. **Statements collect everything not yet locked.** A statement takes *every posted, unlocked transaction dated on or before the period end*, not only the ones inside the period. A forgotten shift or a late payment simply lands on the next statement.
2. **Opening = previous closing.** Each person's opening balance is their closing balance on the group's previous final statement (0 for the first one). "Previous" and "latest" always mean by `periodEnd`, ignoring void statements. A closing whose person was [merged](identity-and-invites.md#merging-two-persons) (`mergedInto` set) and has no member row in the group counts for the person they were merged into, following the chain, and is added to that person's own closing. Every read of previous closings does this: drafting, refresh, preview, reissue and finalize's check (step 5).
3. **Final means locked.** Finalizing sets `statementId` on every included transaction. From then on they cannot be edited or voided ([I-7](ledger.md#invariants)). Fixes are `adjustment` transactions, which land on the next statement.
4. **Totals are sums of stored amounts.** Nothing is recalculated from hours × rate at statement time.
5. **Periods lock in order.** Only the group's oldest unfinished statement (`draft` or `finalizing`, by `periodEnd`) can be finalized; finalizing any other returns `CONFLICT`. Otherwise a later draft would lock an earlier period's transactions and break the opening chain.

## Periods

`periodFor(cycle, anchor, date)` in `packages/core` returns `{ start, end }` as local dates:

| Cycle | Period |
| --- | --- |
| `weekly` | 7 days, starting on `cycleAnchor` and every 7 days after |
| `fortnightly` | 14 days, starting on `cycleAnchor` |
| `monthly` | Calendar month (the anchor is ignored) |

Dates before the anchor fall into earlier periods of the same length, counted backwards. When a group with a weekly or fortnightly cycle sets a future anchor, the `groups` function takes its first `nextCloseAt` from the period that contains the anchor, not today's, so nothing closes before the first real period. Monthly cycles ignore the anchor.

`groups.nextCloseAt` = 06:00 local time on the day after the current period ends, converted to UTC. The six-hour grace lets late entries from the last day make it in.

The job's period ends on the group's local date 12 hours before the stored `nextCloseAt` (normally the day before it). It starts the day after the latest `periodEnd` among the group's statements that end before it, void ones included (a void period is redone by a reissue of its own range). A group's first statement starts where its cycle period does. So a cycle or time zone change leaves no gap or overlap between periods, though the period after it can be longer or shorter than the cycle. One case is left: a move west of more than 18 hours while a period is due can split that period in two (Sydney to Honolulu gives `10-01..10-30`, then `10-31..10-31`).

## Lifecycle

```
           period ends                         admin clicks Finalize (or autoFinalize)
 (none) ───────────────► draft ──────────────────────► finalizing ───► final ───► void
                           ▲  refresh recalculates         (resumable)        (latest only)
                           └──────────────┘
```

### 1. Draft (statements job, hourly at :15)

Appwrite runs the job as `POST /` on the `statements` function; nobody else can call it. For each group where `nextCloseAt <= now` and that isn't archived, in **one database transaction**:

- create a `draft` statement for the period, with a computed snapshot,
- move `groups.nextCloseAt` to the next period's close.

The period is the one that ended the day before the stored `nextCloseAt`, so a cycle or time zone change made after it ended can't skip it. If two job runs race, the second one's commit fails because the group row changed. So there are never two drafts for one period, and the run that lost doesn't count it as a failure. If a statement that isn't void already reaches the period's end (one reissued before the reissue rules in [§4](#4-void-post-statementsidvoid)), the job only moves `nextCloseAt` on. The job lists every due group first and then works through them, so a group that fails every time never keeps the others waiting; a failure is logged (IDs only) and tried again on the next run. Until house divides are built ([#46](https://github.com/rojinc/ledgerly/issues/46)), the job drafts invoices only.

Then email the group admins at their verified addresses: "Your October invoice for Acme is ready to review", linking to `/groups/<groupId>/statements/<statementId>` in the web app. A failed email, even one that can't be built, doesn't undo the draft or stop what follows. If the group setting `autoFinalize` is on, finalize straight away, without sending.

Drafts are **not** locked. Users can keep adding and fixing transactions. `POST /statements/{id}/refresh` (called whenever the draft is opened) recalculates the snapshot.

### 2. Finalize (`POST /statements/{id}/finalize`)

Admin only. Each step checks whether it has already been done, so an interrupted finalize can be called again safely.

1. Set status `finalizing`, with a guard write to the group row (a fresh `rev`) in the same database transaction ([ledger concurrency](ledger.md#concurrency)). Core rule 5 is checked again after staging. While any statement in a group is `finalizing`, the `ledger` function refuses writes to that group's transactions dated on or before the period end (`LOCKED`).
2. **Invoices only:** if `number` is empty, increment the issuer's `profiles.lastInvoiceNumber` and store the result in `number`, with `displayNumber` = prefix + number padded to 4 digits (`INV-0010`), in **one** database transaction. The profile row is staged before it's checked, so two finalizes for one worker can't take the same number, and no number is lost.
3. First finish the unlock of every void statement of the group: a void unlocks after it commits, so one still unlocking, or stopped half way, would leave its transactions out. Then recalculate the snapshot from: posted transactions with `statementId` empty and `date <= periodEnd`, plus any already locked to this statement (from an interrupted run). A transaction that another run of this finalize locks between the two reads counts once.
4. Lock: set `statementId` on those transactions, in batches of at most 90 operations per database transaction.
5. **Check:** each person's closing equals their opening plus the sum of their nets over the lines; the closings add up to 0; and the snapshot's balances equal a fresh sum of all locked shares in the group. If any check fails, set it back to `draft`, then unlock this statement's transactions (in batches) and log an error. Going back to `draft` is checked first: if another run of this finalize stored `issuedOn` meanwhile, its check passed, so this run answers `CONFLICT` and unlocks nothing. Every unlock (here, and a void's) stages each batch with a guard write to the group row, then checks the stored rows: the statement is still as this run left it, and every row in the batch is still locked to it. So it never takes off a lock that another run, or another statement, wrote; it answers `CONFLICT` if a run started finalizing this statement again. Never send a wrong invoice. Going back to `draft` matters: a statement left `finalizing` would block the group's writes for that period forever. The number from step 2 stays on the draft and is reused next time.
6. Store the snapshot with `issuedOn` = local today and `dueOn` = issuedOn + payment terms (invoices; also `invoice.dueOn` in the snapshot). This happens before anything is rendered, so an interrupted finalize that runs again on another day prints the same dates.
7. Render the PDF with `pdfmake`, upload it to the `statements` bucket with the statement's ID as its file ID (so a rerun finds it) and set `pdfFileId`.
8. Set status `final` and `finalizedBy` (empty when the job auto-finalizes).
9. If `send` was requested, email it and set `sentAt`.

Two runs of one finalize at once (a double click, a retry while the first still runs, or `autoFinalize` and an admin) are safe: every step checks the stored row, so the slower run gets `CONFLICT` or finds the step done. A statement left `finalizing` by a crash or a timeout stays that way until finalize is called on it again; nothing resumes it on its own.

### 3. Send and resend (`POST /statements/{id}/send`)

- **Invoice:** sent to the group's `recipients` as they are now, with the PDF attached. Reply-to is the worker's verified email, and the worker gets a copy as a separate email. The idempotency keys come from the `sentAt` read at the start ([conventions](../engineering/conventions.md#functions)): a request retried before `sentAt` is stored reuses them, so Resend delivers each email once, and once `sentAt` is stored the next send is a resend with new keys. (A retry after `sentAt` was stored but its response was lost counts as a resend.) A failed send leaves `sentAt` as it was.
- **Divide:** sent to every active member who has an account (with [#46](https://github.com/rojinc/ledgerly/issues/46)).

### 4. Void (`POST /statements/{id}/void`)

Admin only, and only for the **latest** final statement in the group, so openings never break. It stages `void` with a guard write to the group row (a fresh `rev`), then checks the stored rows: no statement of the group `finalizing` (`CONFLICT`), and still the latest final. The finalizing check comes first because finalize's last step doesn't write the group row: a statement turning final between the two reads is seen by one of them. Reissue reads them in the same order. Then it unlocks its transactions in batches; calling it again on a void statement finishes an interrupted unlock. The reason goes in the `statement.voided` activity row. The snapshot and PDF are kept for history. The next statement's opening comes from the last final statement that isn't void.

To redo a period, call `POST /statements/reissue` with `{ groupId, periodStart, periodEnd }`. This creates a new draft for that range without changing `nextCloseAt`. Once finalized it gets a new number; the void statement keeps its own. While that draft is unfinished, asking again returns it.

A draft that could never be finalized would block every later statement of the group, so after staging the group row reissue refuses:
- a range that doesn't end after the latest final statement (`VALIDATION_FAILED`), since its opening would come from before that statement;
- a range that ends on the same day as another statement that isn't void (`VALIDATION_FAILED`);
- a range that reaches the period the job drafts next (`VALIDATION_FAILED`), which the job would draft again;
- any range while a statement of the group is `finalizing` (`CONFLICT`).

## Snapshot

`snapshotJson` holds everything needed to show or re-render the statement without reading other rows. It is a historical record and is never rewritten.

`buildStatementSnapshot()` in `packages/core` builds it, and `checkSnapshot()` runs finalize step 5. `people` lists everyone with a non-zero opening or a share in the lines, sorted by `personId`; `lines` are sorted by date, then transaction ID. Divides get `suggestTransfers()` of the closings; invoices need an issuer who is a member, a recipient and payment terms, and get the worker's closing as `balanceDueCents`. `invoice.dueOn` stays empty until finalize step 6.

```ts
type StatementSnapshot = {
  version: 1
  group: { id: string; name: string; type: 'employer' | 'house'; currency: string; timezone: string }
  period: { start: string; end: string }
  issuer?: { personId: string; name: string; business: BusinessDetails }  // invoices
  recipient?: { personId: string; name: string; emails: string[] }        // invoices
  people: {
    personId: string; name: string
    openingCents: number; givenCents: number; receivedCents: number; closingCents: number
  }[]
  lines: {
    transactionId: string; date: string; kind: string; description: string; category?: string
    totalCents: number
    shift?: { minutes: number; rateCents: number }
    shares: { personId: string; givenCents: number; receivedCents: number }[]
  }[]
  transfers: { fromPersonId: string; toPersonId: string; cents: number }[]  // divides: suggested settle-up
  invoice?: { balanceDueCents: number; paymentTermsDays: number; dueOn?: string }
  generatedAt: string  // ISO instant
}
```

## Invoice PDF layout (employer)

1. **Header:** issuer business name, ABN, address, email and phone; "INVOICE", number, issue date, due date and period.
2. **Bill to:** employer name and billing email(s).
3. **Opening balance** (from the previous invoice).
4. **Work and charges**, by date: shifts (date, description, hours, rate, amount), reimbursable expenses and adjustments.
5. **Payments received** and deductions, shown as negative amounts.
6. **Balance due.**
7. **For your records:** purchases made on the employer's card for work (net 0), listed but not charged.
8. **How to pay:** bank details and/or PayID, and payment terms.
9. Notes (`invoiceNotes`).

**GST:** v1 does not calculate GST and must not label the PDF a "tax invoice". GST support needs its own design and tax advice before it's built.

## Monthly divide PDF layout (house)

1. House name and period.
2. **People table:** opening, given (paid), received (share), closing.
3. **Suggested transfers** to settle up ("Cara pays Alice $45.20").
4. **Transactions** by date, with each person's share.
