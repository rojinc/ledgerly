# Statements and invoices

A **statement** summarises a group for a period and then locks that period. The same code produces:

- **Invoices** for `employer` groups: what the employer owes you, as a PDF emailed to their billing address.
- **Monthly divides** for `house` groups: who paid what, everyone's share and who should pay whom.

`personal` and `pair` groups have no statements (`statementCycle = none`).

## Core rules

1. **Statements collect everything not yet locked.** A statement takes *every posted, unlocked transaction dated on or before the period end*, not only the ones inside the period. A forgotten shift or a late payment simply lands on the next statement.
2. **Opening = previous closing.** Each person's opening balance is their closing balance on the group's previous final statement (0 for the first one). "Previous" and "latest" always mean by `periodEnd`, ignoring void statements.
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

Dates before the anchor fall into earlier periods of the same length, counted backwards. When a group sets a future anchor, the `groups` function takes its first `nextCloseAt` from the period that contains the anchor, not today's, so nothing closes before the first real period.

`groups.nextCloseAt` = 06:00 local time on the day after the current period ends, converted to UTC. The six-hour grace lets late entries from the last day make it in.

## Lifecycle

```
           period ends                         admin clicks Finalize (or autoFinalize)
 (none) ───────────────► draft ──────────────────────► finalizing ───► final ───► void
                           ▲  refresh recalculates         (resumable)        (latest only)
                           └──────────────┘
```

### 1. Draft (statements job, hourly at :15)

For each group where `nextCloseAt <= now` and that isn't archived, in **one database transaction**:

- create a `draft` statement for the period, with a computed snapshot,
- move `groups.nextCloseAt` to the next period's close.

If two job runs race, the second one's commit fails because the group row changed. So there are never two drafts for one period.

Then email the group admins: "Your October invoice for Acme is ready to review". If the group setting `autoFinalize` is on, finalize straight away.

Drafts are **not** locked. Users can keep adding and fixing transactions. `POST /statements/{id}/refresh` (called whenever the draft is opened) recalculates the snapshot.

### 2. Finalize (`POST /statements/{id}/finalize`)

Admin only. Each step checks whether it has already been done, so an interrupted finalize can be called again safely.

1. Set status `finalizing`. While any statement in a group is `finalizing`, the `ledger` function refuses writes to that group's transactions dated on or before the period end (`LOCKED`).
2. **Invoices only:** if `number` is empty, atomically increment the issuer's `profiles.lastInvoiceNumber` and store the result in `number`. Store `displayNumber` = prefix + number padded to 4 digits (`INV-0010`). A crash between these two writes can leave a gap in numbering; that is acceptable and logged.
3. Recalculate the snapshot from: posted transactions with `statementId` empty and `date <= periodEnd`, plus any already locked to this statement (from an interrupted run).
4. Lock: set `statementId` on those transactions, in batches of at most 90 operations per database transaction.
5. **Check:** each person's closing equals their opening plus the sum of their nets over the lines; the closings add up to 0; and the snapshot's balances equal a fresh sum of all locked shares in the group. If any check fails, unlock this statement's transactions (in batches), set it back to `draft` and log an error. Never send a wrong invoice. Going back to `draft` matters: a statement left `finalizing` would block the group's writes for that period forever. The number from step 2 stays on the draft and is reused next time.
6. Render the PDF with `pdfmake`, upload it to the `statements` bucket and set `pdfFileId`.
7. Set status `final`, `issuedOn` = local today, `dueOn` = issuedOn + payment terms (invoices), and `finalizedBy`.
8. If `send` was requested, email it and set `sentAt`.

### 3. Send and resend (`POST /statements/{id}/send`)

- **Invoice:** sent to the group's `recipients` with the PDF attached. The worker gets a copy, and reply-to is the worker's email.
- **Divide:** sent to every active member who has an account.

### 4. Void (`POST /statements/{id}/void`)

Admin only, and only for the **latest** final statement in the group, so openings never break. It unlocks its transactions in batches and sets status `void`. The snapshot and PDF are kept for history. The next statement's opening comes from the last final statement that isn't void.

To redo a period, call `POST /statements/reissue` with `{ groupId, periodStart, periodEnd }`. This creates a new draft for that range without changing `nextCloseAt`.

## Snapshot

`snapshotJson` holds everything needed to show or re-render the statement without reading other rows. It is a historical record and is never rewritten.

`buildStatementSnapshot()` in `packages/core` builds it, and `checkSnapshot()` runs finalize step 5. `people` lists everyone with a non-zero opening or a share in the lines, sorted by `personId`; `lines` are sorted by date, then transaction ID. Divides get `suggestTransfers()` of the closings; invoices get the worker's closing as `balanceDueCents`.

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
