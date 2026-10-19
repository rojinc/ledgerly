# Statements and invoices

A **statement** summarises a group for a period and then locks that period. The same code produces:

- **Invoices** for `employer` groups: what the employer owes you, as a PDF emailed to their billing address.
- **Monthly divides** for `house` groups: who paid what, everyone's share and who should pay whom.

`personal` and `pair` groups have no statements (`statementCycle = none`).

## Core rules

1. **Statements collect everything not yet locked.** A statement takes *every posted, unlocked transaction dated on or before the period end*, not only the ones inside the period. A forgotten shift or a late payment simply lands on the next statement.
2. **Opening = previous closing.** Each person's opening balance is their closing balance on the group's previous final statement (0 for the first one). "Previous" and "latest" always mean by `periodEnd`, ignoring void statements. A person who was [merged](identity-and-invites.md#merging-two-persons) (`mergedInto` set) and has no member row in the group counts as the person they were merged into, following the chain to the first person with a member row in the group, whatever its status: their closing is added to that person's own, and so are their shares in the lines and in finalize's fresh sum (step 5), while a merge is still moving them. That row may be one U left on their own: a merge moves P's shares only where U has joined, so an opening P carries from a statement before the merge stays U's after U leaves. Where U never joined, P has no shares or closing there to count, since a member row can't be removed while it has shares ([#354](https://github.com/rojinc/ledgerly/issues/354)). Every snapshot does this: drafting, refresh, preview, reissue and finalize.
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

The job's period ends on the group's local date 12 hours before the stored `nextCloseAt` (normally the day before it; core's `periodEndClosedAt`). It starts the day after the latest `periodEnd` among the group's statements that end before it, void ones included (a void period is redone by a reissue of its own range). A group's first statement starts where its cycle period does. So a cycle or time zone change leaves no gap or overlap between periods, though the period after it can be longer or shorter than the cycle. A time zone change while a period is due keeps that period: `groups` reads its end from the stored `nextCloseAt` in the old time zone and stores that end's close in the new one ([#126](https://github.com/rojinc/ledgerly/issues/126)). So a move west (Sydney to Honolulu) drafts October once, later, and a move east doesn't give October a day of November. A time zone change alone does the same when nothing is due yet, so a change after a period ends but before its close, or a move west and back, can't skip that period either.

## Lifecycle

```
           period ends                         admin clicks Finalize (or autoFinalize)
 (none) ───────────────► draft ──────────────────────► finalizing ───► final ───► void
                         │ ▲  refresh recalculates         (resumable)        (latest only)
                         │ └──────────────┘
                         └── discard ──► (deleted)
```

### 1. Draft (statements job, hourly)

Appwrite runs the job as `POST /` on the `statements` function; nobody else can call it. For each group where `nextCloseAt <= now` and that isn't archived, in **one database transaction**:

- create a `draft` statement for the period, with a computed snapshot,
- move `groups.nextCloseAt` to the next period's close.

The period is the one that ended the day before the stored `nextCloseAt`, so a cycle or time zone change made after it ended can't skip it. If two job runs race, the second one's commit fails because the group row changed. So there are never two drafts for one period, and the run that lost doesn't count it as a failure. The job reads its period again after staging the group row: if a [discard](#5-discard-post-statementsiddiscard) committed meanwhile and moved the period's start, the group is left for the next run. A discard that commits later fails one of the two commits, since both write the group row. If a statement that isn't void already reaches the period's end (one reissued before the reissue rules in [§4](#4-void-post-statementsidvoid)), the job only moves `nextCloseAt` on. The job lists every due group first and then works through them, so a group that fails every time never keeps the others waiting; a failure is logged (IDs only) and tried again on the next run. The job drafts an invoice for an employer group and a divide for a house.

**Empty divides:** when a house's period has no lines and every opening is 0, the job drafts nothing and sends no "ready" email. It still moves `nextCloseAt`, so the empty period merges into the next one (before the group's first statement, it's simply skipped).

Then email the group admins at their verified addresses: "Your October invoice for Acme is ready to review", linking to `/groups/<groupId>/statements/<statementId>` in the web app. A failed email, even one that can't be built, doesn't undo the draft or stop what follows. If the group setting `autoFinalize` is on, finalize straight away, without sending.

Drafts are **not** locked. Users can keep adding and fixing transactions. `POST /statements/{id}/refresh` (called whenever the draft is opened) recalculates the snapshot.

### 2. Finalize (`POST /statements/{id}/finalize`)

Admin only. Each step checks whether it has already been done, so an interrupted finalize can be called again safely.

1. Set status `finalizing`, with a guard write to the group row (a fresh `rev`) in the same database transaction ([ledger concurrency](ledger.md#concurrency)). Core rule 5 is checked again after staging. While any statement in a group is `finalizing`, the `ledger` function refuses writes to that group's transactions dated on or before the period end (`LOCKED`), and the group can't be archived (`CONFLICT`). After staging, step 1 also reads the stored group again and refuses with `ARCHIVED` if an archive committed meanwhile, so no statement is left `finalizing` in an archived group.
2. **Invoices only:** if `number` is empty, increment the issuer's `profiles.lastInvoiceNumber` and store the result in `number`, with `displayNumber` = prefix + number padded to 4 digits (`INV-0010`), in **one** database transaction. The profile row is staged before it's checked, so two finalizes for one worker can't take the same number, and no number is lost. A divide skips this step: it never gets a `number` or `displayNumber`, and no profile is read or written, including when a stopped finalize resumes. So on resume, step 2 runs only for an invoice whose `number` is empty.
3. First finish the unlock of every void statement of the group: a void unlocks after it commits, so one still unlocking, or stopped half way, would leave its transactions out. Then recalculate the snapshot from: posted transactions with `statementId` empty and `date <= periodEnd`, plus any already locked to this statement (from an interrupted run). A transaction that another run of this finalize locks between the two reads counts once.
4. Lock: set `statementId` on those transactions, in batches of at most 90 operations per database transaction. Each batch stages a guard write to the group row with its locks, then checks that the stored statement is still `finalizing` with no `issuedOn`; if not, `CONFLICT`. A batch whose commit fails because another write in the group committed first is staged again, up to 3 times; after that the run answers `CONFLICT`, and finalize can be called again. Here's why the guard matters: if one run's check fails and sets the statement back to `draft`, and an admin then [discards](#5-discard-post-statementsiddiscard) it, a slower run that read it as `finalizing` can't lock a row to the deleted statement. Either its batch check fails, or the discard's group-row write fails one of the two commits.
5. **Check:** each person's closing equals their opening plus the sum of their nets over the lines; the closings add up to 0; and the snapshot's balances equal a fresh sum of all locked shares in the group. The fresh sum counts merged people (rule 2) against the member rows step 3 read, so a merge that deletes or repoints one in between can't fail the check. If any check fails, set it back to `draft`, then unlock this statement's transactions (in batches) and log an error. Going back to `draft` is checked first: if another run of this finalize stored `issuedOn` meanwhile, its check passed, so this run answers `CONFLICT` and unlocks nothing. Every unlock (here, and a void's) stages each batch with a guard write to the group row, then checks the stored rows: the statement is still as this run left it, and every row in the batch is still locked to it. So it never takes off a lock that another run, or another statement, wrote; it answers `CONFLICT` if a run started finalizing this statement again. Never send a wrong invoice. Going back to `draft` matters: a statement left `finalizing` would block the group's writes for that period forever. The number from step 2 stays on the draft and is reused next time.
6. Store the snapshot with `issuedOn` = local today and `dueOn` = issuedOn + payment terms (invoices; also `invoice.dueOn` in the snapshot). A divide leaves `dueOn` empty. This happens before anything is rendered, so an interrupted finalize that runs again on another day prints the same dates.
7. Render the PDF with `pdfmake`, upload it to the `statements` bucket with the statement's ID as its file ID (so a rerun finds it) and set `pdfFileId`. The file is named `<displayNumber>.pdf` for an invoice and `divide-<periodEnd>.pdf` for a divide.
8. Set status `final` and `finalizedBy` (empty when the job auto-finalizes).
9. If `send` was requested, email it and set `sentAt`.

Two runs of one finalize at once (a double click, a retry while the first still runs, or `autoFinalize` and an admin) are safe: every step checks the stored row, so the slower run gets `CONFLICT` or finds the step done. A statement left `finalizing` by a crash or a timeout stays that way until finalize is called on it again; nothing resumes it on its own.

The finalized, sent, voided and discarded summaries in `activity` name an invoice by its number, and a statement with no number (a divide, or a discarded invoice draft) by its period, worded as in the emails: "Divide for October finalized" for a calendar month, "Divide for 1–14 October finalized" otherwise, and the same pattern for sent, voided and discarded. (`statement.drafted` keeps "Statement for the period ending … drafted".)

### 3. Send and resend (`POST /statements/{id}/send`)

- **Invoice:** sent to the group's `recipients` as they are now, with the PDF attached. Reply-to is the worker's verified email, and the worker gets a copy as a separate email. The idempotency keys come from the `sentAt` read at the start ([conventions](../engineering/conventions.md#functions)): a request retried before `sentAt` is stored reuses them, so Resend delivers each email once, and once `sentAt` is stored the next send is a resend with new keys. (A retry after `sentAt` was stored but its response was lost counts as a resend.) A failed send leaves `sentAt` as it was.
- **Divide:** each `active` member, and each `left` member who is still in the team (moved out) and appears in the snapshot's `people`, gets one email of their own at their verified addresses. No email names another member's address.
  - It shows their closing ("You owe $45.20", "You're owed $45.20" or "You're settled up") and their own suggested transfers, links to the statement and has the PDF attached. It has no reply-to.
  - Each email has its own key: `divide/<statementId>/<sentAt read before sending, or first>/<personId>`. So a retry before `sentAt` is stored reuses them, as for invoices.
  - A failed send leaves `sentAt` as it was. If no recipient has a verified email, the send returns `VALIDATION_FAILED` and leaves `sentAt` unchanged.

### 4. Void (`POST /statements/{id}/void`)

Admin only, and only for the **latest** final statement in the group, so openings never break. It stages `void` with a guard write to the group row (a fresh `rev`), then checks the stored rows: no statement of the group `finalizing` (`CONFLICT`), and still the latest final. The finalizing check comes first because finalize's last step doesn't write the group row: a statement turning final between the two reads is seen by one of them. Reissue reads them in the same order. Then it unlocks its transactions in batches; calling it again on a void statement finishes an interrupted unlock. A merge renames merged persons in locked rows too ([merging](identity-and-invites.md#merging-two-persons), step 3), so the rows a void unlocks can be edited as they are, apart from two kinds that keep naming P: a payment between the two, and a row the merge couldn't read. The reason goes in the `statement.voided` activity row. The snapshot and PDF are kept for history. The next statement's opening comes from the last final statement that isn't void.

To redo a period, call `POST /statements/reissue` with `{ groupId, periodStart, periodEnd }`. This creates a new draft for that range without changing `nextCloseAt`. Once finalized, an invoice gets a new number; the void statement keeps its own. While that draft is unfinished, asking again returns it.

A draft that could never be finalized would block every later statement of the group, so after staging the group row reissue refuses:
- a range that doesn't end after the latest final statement (`VALIDATION_FAILED`), since its opening would come from before that statement;
- a range that ends on the same day as another statement that isn't void (`VALIDATION_FAILED`);
- a range that reaches the period the job drafts next (`VALIDATION_FAILED`), which the job would draft again;
- any range while a statement of the group is `finalizing` (`CONFLICT`).

### 5. Discard (`POST /statements/{id}/discard`)

Admin only, and drafts only. It deletes the draft; there's no `discarded` status.

- A `finalizing` statement gets `CONFLICT`: call finalize again instead.
- A `final` one gets `VALIDATION_FAILED` (void it instead), and so does a `void` one.
- So does an invoice draft that already has a `number`, since finalize step 2 promises no number is lost.

Steps:

1. Unlock any transactions still locked to the draft, in batches, as void does. A finalize whose check failed and whose unlock stopped halfway leaves these.
2. In one database transaction, stage the delete, a guard write to the group row and a `statement.discarded` activity row.
3. After staging, check that the stored row is still `draft`, still has no `number`, and that no transaction is locked to it. If not, `CONFLICT`. (A finalize that ran meanwhile may have numbered the draft, failed its check and set it back to `draft`.)

Calling it again gets `NOT_FOUND`, which the app treats as done.

**Periods.** `nextCloseAt` doesn't move, and the draft's transactions land on the next statement ([core rule 1](#core-rules)).

- Discarding a draft that ends after every other statement of the group, void ones included, rolls its period into the next draft. The next period starts the day after the latest `periodEnd` that remains, void ones included ([periods](#periods)), so a reissue of the discarded range is refused, since that period hasn't been drafted yet. If no statement remains, the next draft starts where its cycle period does, and the discarded range can be reissued. To recalculate a draft, refresh it rather than discarding it.
- Discarding any other draft, such as a reissue of a void statement's range, leaves the period boundaries as they were, and the range can be reissued again.

**Files.** A draft never has a PDF, because step 7 runs while `finalizing`, so discard doesn't touch storage.

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

**Fonts (#270):** the PDF prints in the Roboto that pdfmake bundles (Latin with accents, Greek and Cyrillic), then Noto Sans CJK SC (Chinese, Japanese and Korean), then Noto Emoji (monochrome). `fontRuns()` (`packages/core/src/pdf/pdf-glyphs.ts`) splits every text the invoice prints into runs: each character, or whole emoji sequence, goes to the first font that has it, and pdfmake gets one text per run in its font.

- **Regular only.** Bold Chinese, Japanese, Korean and emoji print regular: bold CJK files would double the deployment.
- **One pan-CJK font,** so Han characters take Simplified Chinese shapes, in a Japanese or Korean name too.
- **Read when needed.** The Noto files are too big to bundle, so they sit in the function's `dist/fonts/` ([deploys](../engineering/environments-and-deploys.md#function-settings)). A file is read the first time a text needs its font and kept while the instance is warm, so a Latin invoice reads none.
- **Licence:** both fonts are under the SIL Open Font License 1.1 (`packages/server/fonts/NotoSansCJK-OFL.txt`; Noto Emoji's ships in its npm package).

**Characters no font has:** Thai, Hebrew, Arabic and other scripts, and emoji that Noto Emoji lacks. pdfmake would leave those out without a trace, so each prints as `�` (`missingGlyphs()` and `printable()` mean "no font of the PDF has it"). The text is composed (Unicode NFC) first: Roboto has the accented letters but few combining marks, so decomposed text, as macOS paste and some Vietnamese input methods give it, would otherwise lose its accents. A letter Roboto has only as base and mark, such as `ṣ` or `ὰ`, prints from those parts. The render logs only how many characters print as `�` (`pdf_characters_replaced`), never the text, and the draft page warns before finalize when the snapshot has any.

**GST:** v1 does not calculate GST and must not label the PDF a "tax invoice". GST support needs its own design and tax advice before it's built.

## Monthly divide PDF layout (house)

1. House name and period.
2. **People table:** opening, given (paid), received (share), closing.
3. **Suggested transfers** to settle up ("Cara pays Alice $45.20").
4. **Transactions** by date, with each person's share.

**Fonts (#300):** the same as the invoice's. Every text from the snapshot (the house name, people's names, transfers and line descriptions) prints as `fontRuns()` splits it, a character no font has prints as `�`, and the render logs only how many (`pdf_characters_replaced`). Unicode's line breaks other than a line feed or carriage return print as line feeds, since no font has them. A word that would print wider than the People table's Name column (151 pt, at its fonts' widest) gets a zero-width space, so pdfmake can break it there and no column pushes the amounts off the page. A Latin divide reads no font file.

It's never called an invoice and has no GST. The file is named `divide-<periodEnd>.pdf`. The snapshot stays `version: 1`, unchanged: its schema is a strict object, so a new field would make today's readers refuse every divide.
