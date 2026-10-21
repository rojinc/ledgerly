# Statements and invoices

A **statement** summarises a group for a period and then locks that period. The same code produces:

- **Invoices** for `employer` groups: what the employer owes you, as a PDF emailed to their billing address.
- **Monthly divides** for `house` groups: who paid what, everyone's share and who should pay whom.

`personal` and `pair` groups have no statements. An `employer` or `house` group with no cycle (`statementCycle = none`) gets one only when an admin [closes a period](#6-close-a-period-now-post-statementsclose).

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

Dates before the anchor fall into earlier periods of the same length, counted backwards. So when a weekly or fortnightly group's anchor is later than the day a close is worked out from, the next close is the end of the period that contains the anchor, not of the period that contains that day: nothing closes before the first real period, and, once the group has a statement, the days before the anchor fold into it (a first statement starts where its cycle period does, below). That holds both when the `groups` function takes a new `nextCloseAt` from today, and when the statements job moves `nextCloseAt` on from the day after the period it drafted ([§1](#1-draft-statements-job-hourly); [#405](https://github.com/rojinc/ledgerly/issues/405)). For example, a monthly group whose October close is kept while it changes to weekly, anchored on Monday 2 November, drafts 1–31 October and then 1–8 November, never a 1 November stub. Core's `firstPeriodEnd(cycle, anchor, from)` is the one rule both use. Monthly cycles ignore the anchor.

`groups.nextCloseAt` = 06:00 local time on the day after the current period ends, converted to UTC. The six-hour grace lets late entries from the last day make it in.

The job's period ends on the group's local date 12 hours before the stored `nextCloseAt` (normally the day before it; core's `periodEndClosedAt`). It starts the day after the latest `periodEnd` among the group's statements that end before it, void ones included (a void period is redone by a reissue of its own range). A group's first statement starts where its cycle period does. So a cycle or time zone change leaves no gap or overlap between periods, though the period after it can be longer or shorter than the cycle. The same holds after an admin [closes a period early](#6-close-a-period-now-post-statementsclose): that draft ends inside the job's period, so the job's draft starts the day after it and covers only the rest. A change of cycle, anchor or time zone while a period is due keeps that period. It's due once it has ended, read in the group's time zone before the change, or once the stored `nextCloseAt` has passed, until the job drafts it. `groups` keeps the stored `nextCloseAt`, or, when the time zone changes, reads the period's end from it in the old time zone and stores that end's close in the new one ([#126](https://github.com/rojinc/ledgerly/issues/126)). So a move west (Sydney to Honolulu) drafts October once, later; a move east doesn't give October a day of November; and a cycle change once October has ended in the group's time zone doesn't merge it into the next period. One made before then works the close out from today, as for any group, so the period after it is longer; that's also so after a move west, while October hasn't ended in the new time zone yet. A time zone change alone does the same when nothing is due yet, so a move east into a time zone where the period has already ended can't skip it either.

An [unarchive](functions-api.md#groups) works `nextCloseAt` out from today, as for a cycle change, so the weeks the group was archived join the first period after it. That period starts the day after the latest statement, as above, so there's no gap and no overlap ([#428](https://github.com/rojinc/ledgerly/issues/428)).

## Lifecycle

```
       period ends, or
       admin closes it now (§6)                admin clicks Finalize (or autoFinalize)
 (none) ───────────────► draft ──────────────────────► finalizing ───► final ───► void
                         │ ▲  refresh recalculates         (resumable)        (latest only)
                         │ └──────────────┘
                         └── discard ──► (deleted)
```

### 1. Draft (statements job, hourly)

Appwrite runs the job as `POST /` on the `statements` function; nobody else can call it. For each group where `nextCloseAt <= now` and that isn't archived, in **one database transaction**:

- create a `draft` statement for the period, with a computed snapshot,
- move `groups.nextCloseAt` to the next period's close, worked out from the day after this period's end, with a future anchor's rule ([periods](#periods)).

The period is the one that ended the day before the stored `nextCloseAt`, so a cycle or time zone change made after it ended can't skip it. If two job runs race, the second one's commit fails because the group row changed. So there are never two drafts for one period, and the run that lost doesn't count it as a failure. The job reads its period again after staging the group row: if a [discard](#5-discard-post-statementsiddiscard) committed meanwhile and moved the period's start, the group is left for the next run. A discard that commits later fails one of the two commits, since both write the group row. If a statement that isn't void already reaches the period's end (an [early close](#6-close-a-period-now-post-statementsclose) that ended on the period's last day, or one reissued before the reissue rules in [§4](#4-void-post-statementsidvoid)), the job only moves `nextCloseAt` on. The job lists every due group first and then works through them, so a group that fails every time never keeps the others waiting; a failure is logged (IDs only) and tried again on the next run. The job drafts an invoice for an employer group and a divide for a house.

**Empty divides:** when a house's period has no lines and every opening is 0, the job drafts nothing and sends no "ready" email. It still moves `nextCloseAt`, so the empty period merges into the next one (before the group's first statement, it's simply skipped).

If the group setting `autoFinalize` is on, finalize straight away, without sending, unless an earlier statement is still unfinished (an [early close](#6-close-a-period-now-post-statementsclose)'s draft): rule 5 would refuse it, so it waits for an admin, as one whose finalize fails does, and nothing is logged ([#420](https://github.com/rojinc/ledgerly/issues/420)).

Then email the group admins at their verified addresses: "Your October invoice for Acme is ready to review", linking to `/groups/<groupId>/statements/<statementId>` in the web app, and to `/profile`, where this email can be turned off. After an auto-finalize, the email says the statement has been finalized, and that it can be voided or sent from its page ([#523](https://github.com/rojinc/ledgerly/issues/523)). In an employer group with `autoSend` on, it goes only when that finalize was skipped or failed, or the invoice has no lines, so it's the email that says the admin is needed: otherwise the invoice is on its way to the billing emails ([auto-send](#auto-send)). An admin whose profile's [`emailOptOuts`](data-model.md#profiles) lists `statementReady` gets none ([#431](https://github.com/rojinc/ledgerly/issues/431)). When every admin has turned it off, nothing is sent, but the draft, its activity row and the auto-finalize above all go ahead, and the draft is still listed under Statements. A failed email, even one that can't be built, isn't tried again, and doesn't undo the draft or stop the drafts and [auto-send](#auto-send) that follow. A failure every send would meet (`sendingBlocked()`, [conventions](../engineering/conventions.md#functions)) is logged once, and the run tries no other "ready" email, for this group's admins or any later group's, and no later run sends them ([#476](https://github.com/rojinc/ledgerly/issues/476)). Any other failed send is logged per admin, and the next admin is tried.

An admin can also draft the period so far without waiting for it to end ([§6](#6-close-a-period-now-post-statementsclose)).

#### Auto-send

An employer group can have the job email the invoices it auto-finalizes ([#432](https://github.com/rojinc/ledgerly/issues/432)). The setting `autoSend` needs `autoFinalize` and at least one billing email (`VALIDATION_FAILED` otherwise), and it's off unless an admin turns it on. Only an invoice the job finalized itself is sent this way: not one an admin finalized, one from a close or a reissue, or a divide. Nor is an invoice with no lines, such as an idle period, or the rest of a period after an [early close](#6-close-a-period-now-post-statementsclose): its balance due is the worker's closing balance, which the employer may already have been invoiced for, so it could ask them to pay twice. The job still finalizes it, and the "ready" email goes to the admins, who can void it or send it.

- **The window:** when the job finalizes an invoice with at least one line in a group with `autoSend` on, finalize step 8 also sets `autoSendUntil` to 23 hours later. Until then, the invoice is the job's to send.
- **The step:** every run, after drafting and within the same time budget, the job lists `final` invoices with no `sentAt` and `autoSendUntil` after now (`idx_autoSendUntil`). It reads each one and its group again, and skips one that's no longer `final` (a void), already sent, or in a group that's archived or has `autoSend` off, writing nothing. Otherwise it sends it as [§3](#3-send-and-resend-post-statementsidsend) does, with no actor: the same recipients, PDF, reply-to and copy to the worker, and the same keys, `invoice/<statementId>/first/employer` and `/copy`. Then it stores `sentAt`, if it's still empty, with one `statement.sent` activity row naming no one. So the first try is in the same run as the finalize.
- **An admin's Send in the window** uses the same keys, since `sentAt` is still empty. Resend delivers each email once, and only one of the two `sentAt` writes commits, with one activity row. If the billing emails change after the job's first try, the same key now carries a different email: Resend refuses the job's next try with a 409 (`invalid_idempotent_request`, permanent, below), and an admin's Send too, until 24 hours after that first try. That's accepted (#432's Q5).
- **A transient failure** changes neither column: a timeout, the network, a 5xx from Resend, Appwrite, a failed read of one invoice, or any Resend error not named as permanent below. That includes `concurrent_idempotent_requests`, an admin's Send of the same invoice at the same moment. It logs `auto_send_failed` with the IDs and the error type only, and the next run tries again with the same keys. A 429 from Resend ends the step for that run, after the admins are told, since the limit is shared. A failure every send would meet (`sendingBlocked()`: a 401 or 403, a `validation_error` among them, an invalid key or a missing setting, [conventions](../engineering/conventions.md#functions)) is ours, not the invoice's: it ends the step too, logged once, and the admins aren't told, since that email would fail the same way. If the notice to the admins meets one, after another failure, the step ends there, and the admins after it wait for the next run ([#469](https://github.com/rojinc/ledgerly/issues/469)).
- **A permanent failure** sets `autoSendUntil` to now once the admins are told, so no later run tries. That's an invoice that can't go as it is (no billing email, or no verified email for the worker's reply-to and copy, which an admin's Send would do without), or Resend's `validation_error` with 400 or 422, or `invalid_idempotent_request`. If the notice to the admins meets a failure every send would meet, the window stays open, so the next run tries the invoice again, under the same keys, and then tells the admins left ([#494](https://github.com/rojinc/ledgerly/issues/494)). If it's still blocked when the window ends, 23 hours after the finalize, the notice is never sent, as with the accepted risk below.
- **Telling the worker:** after a failure of either kind, a 429 included but not one every send would meet, each joined admin gets "Invoice INV-0010 for Acme couldn't be emailed" at their verified addresses, linking to the statement. Its key is `auto-send-failed/<statementId>/<personId>`. The window ends inside Resend's 24-hour key life, so each admin gets it once however many runs fail. No notification setting mutes it.
- **After the window,** only an admin's Send. Every try inside it reuses the same keys, so the employer gets the invoice once.
- **Accepted:** if the job doesn't run for 23 hours after the finalize, the invoice isn't sent and no notice goes out. The statement page says it couldn't be emailed automatically, and Send is still there.

Drafts are **not** locked. Users can keep adding and fixing transactions. `POST /statements/{id}/refresh` (called whenever the draft is opened) recalculates the snapshot.

### 2. Finalize (`POST /statements/{id}/finalize`)

Admin only. Each step checks whether it has already been done, so an interrupted finalize can be called again safely. An invoice whose issuer has deleted their account (their `persons.deletedAt` is set: account deletion's point of no return, never cleared, [order](identity-and-invites.md#order)) is refused with `CONFLICT` before step 1, on a resume too, and by the job as well as an admin: it couldn't be numbered, and an issued one would lack their business details ([a stuck finalize](identity-and-invites.md#each-group-they-joined), [#503](https://github.com/rojinc/ledgerly/issues/503)). Steps 2 and 6 check the issuer again, so a run that began before the deletion can't number or issue the invoice after it. Since nobody can finish such an invoice, it doesn't hold up an admin's account deletion (refusal 5), nor, once the issuer's `deletedAt` is more than an hour old, an admin's archive ([#519](https://github.com/rojinc/ledgerly/issues/519)). By then no run that began before the deletion can still be going: a run stops after 300 s.

1. Set status `finalizing`, with a guard write to the group row (a fresh `rev`) in the same database transaction ([ledger concurrency](ledger.md#concurrency)). Core rule 5 is checked again after staging. While any statement in a group is `finalizing`, the `ledger` function refuses writes to that group's transactions dated on or before the period end (`LOCKED`), and an admin can't archive the group (`CONFLICT`), unless it's an invoice whose issuer deleted their account more than an hour ago (above). After staging, step 1 also reads the stored group again and refuses with `ARCHIVED` if an archive committed meanwhile, so no finalize leaves its statement `finalizing` in an archived group. An account deletion archives a group over a finalize stuck for an hour ([a stuck finalize](identity-and-invites.md#each-group-they-joined)), and an admin's archive goes over an invoice whose issuer deleted their account more than an hour ago, which stays `finalizing`; no other archive goes over a finalize ([#519](https://github.com/rojinc/ledgerly/issues/519)).
2. **Invoices only:** if `number` is empty, check the issuer again (`deletedAt` set, or their profile missing, is the same `CONFLICT`, and the statement stays as it was), then increment the issuer's `profiles.lastInvoiceNumber` and store the result in `number`, with `displayNumber` = prefix + number padded to 4 digits (`INV-0010`), in **one** database transaction. The profile row is staged before it's checked, so two finalizes for one worker can't take the same number, and no number is lost. A divide skips this step: it never gets a `number` or `displayNumber`, and no profile is read or written, including when a stopped finalize resumes. So on resume, step 2 runs only for an invoice whose `number` is empty.
3. First finish the unlock of every void statement of the group: a void unlocks after it commits, so one still unlocking, or stopped half way, would leave its transactions out. Then recalculate the snapshot from: posted transactions with `statementId` empty and `date <= periodEnd`, plus any already locked to this statement (from an interrupted run). A transaction that another run of this finalize locks between the two reads counts once.
4. Lock: set `statementId` on those transactions, in batches of at most 90 operations per database transaction. Each batch stages a guard write to the group row with its locks, then checks that the stored statement is still `finalizing` with no `issuedOn`; if not, `CONFLICT`. A batch whose commit fails because another write in the group committed first is staged again, up to 3 times; after that the run answers `CONFLICT`, and finalize can be called again. Here's why the guard matters: if one run's check fails and sets the statement back to `draft`, and an admin then [discards](#5-discard-post-statementsiddiscard) it, a slower run that read it as `finalizing` can't lock a row to the deleted statement. Either its batch check fails, or the discard's group-row write fails one of the two commits.
5. **Check:** each person's closing equals their opening plus the sum of their nets over the lines; the closings add up to 0; and the snapshot's balances equal a fresh sum of all locked shares in the group. The fresh sum counts merged people (rule 2) against the member rows step 3 read, so a merge that deletes or repoints one in between can't fail the check. If any check fails, set it back to `draft`, then unlock this statement's transactions (in batches) and log an error. Going back to `draft` is checked first: if another run of this finalize stored `issuedOn` meanwhile, its check passed, so this run answers `CONFLICT` and unlocks nothing. Every unlock (here, and a void's) stages each batch with a guard write to the group row, then checks the stored rows: the statement is still as this run left it, and every row in the batch is still locked to it. So it never takes off a lock that another run, or another statement, wrote; it answers `CONFLICT` if a run started finalizing this statement again. Never send a wrong invoice. Going back to `draft` matters: a statement left `finalizing` would block the group's writes for that period forever. The number from step 2 stays on the draft and is reused next time.
6. **Invoices:** check the issuer again first, as in step 2: the snapshot step 3 built may lack their business details if their deletion ran meanwhile. Then store the snapshot with `issuedOn` = local today and `dueOn` = issuedOn + payment terms (invoices; also `invoice.dueOn` in the snapshot). A divide leaves `dueOn` empty. This happens before anything is rendered, so an interrupted finalize that runs again on another day prints the same dates.
7. Render the PDF with `pdfmake`, upload it to the `statements` bucket with the statement's ID as its file ID (so a rerun finds it) and set `pdfFileId`. The file is named `<displayNumber>.pdf` for an invoice and `divide-<periodEnd>.pdf` for a divide.
8. Set status `final` and `finalizedBy` (empty when the job auto-finalizes). When the job finalizes an invoice with at least one line in a group with `autoSend` on, the same write sets `autoSendUntil` to 23 hours later ([auto-send](#auto-send)).
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
- a range that overlaps another draft of the group, other than one of exactly that range, which is returned (`VALIDATION_FAILED`): rule 5 would still finalize the two in order, so no amount would be wrong, but both would cover the same days ([#420](https://github.com/rojinc/ledgerly/issues/420));
- a range that reaches the period the job drafts next (`VALIDATION_FAILED`), which the job would draft again;
- in a group with no cycle, a range that ends after the group's latest statement, void ones included, or any range if it has none (`VALIDATION_FAILED`): there, new periods come only from a [close](#6-close-a-period-now-post-statementsclose), so a reissue only redoes a void one;
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

- Discarding a draft that ends after every other statement of the group, void ones included, rolls its period into the next draft. The next period starts the day after the latest `periodEnd` that remains, void ones included ([periods](#periods)), so a reissue of the discarded range is refused, since that period hasn't been drafted yet. If no statement remains, the next draft starts where its cycle period does (or, with no cycle, where a [close](#6-close-a-period-now-post-statementsclose)'s first statement does), and in a group with a cycle the discarded range can be reissued. To recalculate a draft, refresh it rather than discarding it.
- Discarding any other draft, such as a reissue of a void statement's range, leaves the period boundaries as they were, and the range can be reissued again.

**Files.** A draft never has a PDF, because step 7 runs while `finalizing`, so discard doesn't touch storage.

### 6. Close a period now (`POST /statements/close`)

Admin only, in an `employer` or a `house` group. Other groups get `VALIDATION_FAILED`, and an archived group gets `ARCHIVED`. The route drafts the group's next statement now, up to `periodEnd`, instead of waiting for the job: an invoice whenever the worker wants to bill, or a divide when a housemate moves out. It returns the draft, and the admin finalizes it as usual ([§2](#2-finalize-post-statementsidfinalize)). A group with cycle `none` gets its statements this way, since the job never drafts one for it, and a reissue only redoes a void one ([§4](#4-void-post-statementsidvoid)).

**Period.**
- **The end** is `periodEnd`. It defaults to today in the group's time zone, or to the end of the job's next period if that's earlier. That happens in the hours after a period ends, before the job drafts it. The app always sends the day the admin confirmed.
- **The start** is the day after the latest `periodEnd` among the group's statements, void ones included. The job counts only statements that end before its period does ([periods](#periods)); a close counts them all, so a second close can't overlap one that ended on the job's period end.
- **A group's first statement** starts where the cycle period containing `periodEnd` starts. With cycle `none`, it starts on the date of the group's earliest posted transaction dated on or before `periodEnd`, or on the day the group was created (in its time zone) if it has none.

**Like the job's drafts:**
- the same snapshot, built by the same code: every posted, unlocked transaction dated on or before `periodEnd` ([core rule 1](#core-rules));
- a `statement.drafted` activity row, with the admin as its actor.

**Unlike them:**
- `nextCloseAt` and the cycle don't move;
- no "ready" email is sent, since the route returns the draft to the admin who asked;
- `autoFinalize` doesn't apply;
- a divide with nothing in it is drafted too, and the admin can discard it.

**Locking ([I-7](ledger.md#invariants)) is unchanged:** finalizing locks every transaction dated on or before `periodEnd`. Entries dated after it go on the next statement, and the app says so before it closes the period.

**At period end** the job drafts the rest: its period starts the day after the early close. That can be an empty employer invoice, which the admin can discard unless `autoFinalize` finalized it, as for any period the job drafts. With `autoSend` on, it isn't emailed: an invoice with no lines never is ([auto-send](#auto-send)). If the early close ended on the period's last day, the job only moves `nextCloseAt` on ([§1](#1-draft-statements-job-hourly)).

**Asking again** with the same `periodEnd` returns the group's statement that ends on that day, while it's still unfinished (`draft` or `finalizing`), whoever drafted it. So a retry makes no second draft. This is read before any refusal but the caller's role and an archived group, and read again after staging, as for a reissue.

**Refusals.** The route stages a guard write to the group row, then reads the stored rows and refuses:
- a group archived meanwhile (`ARCHIVED`), as finalize step 1 does;
- any close while a statement of the group is `finalizing` (`CONFLICT`);
- any close while another draft of the group is unfinished: `CONFLICT`, with `details: { draftId }` naming the oldest one by `periodEnd`, so the app can link to it. Periods lock in order ([core rule 5](#core-rules)), so that draft must be finalized or discarded first;
- a `periodEnd` after today in the group's time zone, before the period's start, or after the end of the period the job drafts next (`VALIDATION_FAILED`). A group with no cycle has no job period, so only the first two apply.

It reads the period's start again after staging, and answers `CONFLICT` (try again) if a draft or a discard that committed meanwhile moved it, so no two periods overlap and none leaves a gap. A job run or another close at the same moment fails one of the two commits, since both write the group row.

**The current period so far.** `POST /statements/preview` shows any member what the statement would hold if it were closed on `periodEnd`. The default and the start are a close's, not the cycle period's, so the preview matches what an admin would draft. A statement may already cover that day (a close ended today); then the preview starts where the cycle period does (a calendar month with no cycle), as before. Nothing is saved, nothing is refused for being early or late, and it works in an archived group too.

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

**Long words ([#360](https://github.com/rojinc/ledgerly/issues/360)):** pdfmake widens a column to its widest word, so a word, or words it glues together, that would print wider than its column, at its fonts' widest, gets a zero-width space where pdfmake can break it. A line's description is narrowed to the narrowest Description column (221 pt), and the issuer's lines to the width left beside the INVOICE block (250 pt, with the business name at 14 pt). So no column pushes the amounts, or the INVOICE block, off the page. The invoice number is never broken, since it's the payment reference.

**GST:** v1 does not calculate GST and must not label the PDF a "tax invoice". GST support needs its own design and tax advice before it's built.

## Monthly divide PDF layout (house)

1. House name and period.
2. **People table:** opening, given (paid), received (share), closing.
3. **Suggested transfers** to settle up ("Cara pays Alice $45.20").
4. **Transactions** by date, with each person's share.

**Fonts (#300):** the same as the invoice's. Every text from the snapshot (the house name, people's names, transfers and line descriptions) prints as `fontRuns()` splits it, a character no font has prints as `�`, and the render logs only how many (`pdf_characters_replaced`). Unicode's line breaks other than a line feed or carriage return print as line feeds, since no font has them. A word that would print wider than the People table's Name column (151 pt, at its fonts' widest) gets a zero-width space, so pdfmake can break it there and no column pushes the amounts off the page. Words pdfmake glues together, across fonts (an emoji, then a no-break space), count as one, since it never cuts a piece of one character. A Latin divide reads no font file.

It's never called an invoice and has no GST. The file is named `divide-<periodEnd>.pdf`. The snapshot stays `version: 1`, unchanged: its schema is a strict object, so a new field would make today's readers refuse every divide.
