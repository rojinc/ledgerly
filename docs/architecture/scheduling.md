# Scheduling

Schedules create transactions automatically: a Thursday shift, weekly rent, a monthly phone bill. The `scheduler` function also runs every other time-based job: auto-posting, reminders and summary emails.

## What a schedule is

A row in `schedules` ([data model](data-model.md#schedules)) with:

- a **template**: the transaction to create (kind, description, amount or minutes × rate, payers, split). A bill template is `due` with no `dueOn`, since each occurrence is due on its own date, and has no billing period, since one period can't fit every occurrence, and so no `days` split ([days present](ledger.md#days-present)); recurring days-present bills are for later,
- a **recurrence rule** (RFC 5545 `RRULE`), a start date and an optional end date,
- skip rules: specific dates (`exdates`) and optionally public holidays for the group's region,
- `autoPost`: whether occurrences post themselves.

### Rules the UI builds

| User says | `rrule` |
| --- | --- |
| Every Thursday | `FREQ=WEEKLY;BYDAY=TH` |
| Every other Tuesday | `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU` (counted from `startsOn`) |
| Mon, Wed and Fri | `FREQ=WEEKLY;BYDAY=MO,WE,FR` |
| On the 1st of every month | `FREQ=MONTHLY;BYMONTHDAY=1` |
| On the last day of every month | `FREQ=MONTHLY;BYMONTHDAY=-1` |

The UI only offers these, and the API accepts only these shapes, with the parts in any order:

- `FREQ=WEEKLY;BYDAY=<days>`, where `<days>` is one or more of `MO`–`SU` (no ordinals such as `-1FR`), with an optional `INTERVAL` of 1–4.
- `FREQ=MONTHLY;BYMONTHDAY=<n>`, where `n` is 1–28 or `-1` (the last day), so every month has it.
- Either shape may add `COUNT` (1–500) or `UNTIL=<YYYYMMDD>` on a real calendar day no earlier than `startsOn`, but not both.

`startsOn`, `endsOn` and every `exdate` must be on or after 2000-01-01. Anything else returns `VALIDATION_FAILED`: other rules (`DAILY`, `YEARLY`, `BYSETPOS`, `BYWEEKNO`, `BYMONTH`, impossible days) and very early start dates can take seconds to expand, and `POST /schedules` and `/schedules/preview` expand while the caller waits.

## Expanding occurrences

`expandSchedule(schedule, from, to, holidays) → LocalDate[]` in `packages/core` is pure and tested.

**Timezone rule:** expand in *floating* dates. Turn `YYYY-MM-DD` into `Date.UTC(y, m - 1, d)`, run `rrule` in UTC, and turn the results back into `YYYY-MM-DD`. Never let the server's or browser's timezone touch a local date. This is the classic bug that moves Thursday to Wednesday.

`INTERVAL` counts from the week (weeks start on Monday) or month of `startsOn`: "every other Tuesday" starting on a Wednesday first falls 13 days later. `COUNT` counts dates before `exdates` and holidays are taken out, as RFC 5545 does. A rule's `UNTIL`, or its `COUNT`th date, ends the schedule as `endsOn` does: expansion stops there and clears `nextRunAt`.

Skip a date when:

- it is before `startsOn` or after `endsOn`,
- it is in `exdates`,
- `skipPublicHolidays` is on and it is a public holiday in the group's `region`.

### Public holidays

- Use `date-holidays`: region `AU-NSW` becomes `new Holidays('AU', 'NSW')`.
- Count only holidays of type `public`. Ignore `bank`, `school`, `observance` and so on.
- Count only whole days: a holiday lasting several days counts each day, and one starting after midnight (Christmas Eve evening, a half day) doesn't count.
- Compare local dates: core's `publicHolidayChecker(region)` matches the `YYYY-MM-DD` part of each holiday's local date string, so no timezone or midnight edge case is involved.
- An unknown region (a country or state the library doesn't have) throws, rather than silently skipping nothing.
- Users can still add a shift on a holiday by hand, or skip any other day with `exdates`.

## Idempotency

The scheduler may run twice, overlap with itself or crash halfway. None of that may create duplicates.

- **Deterministic occurrence IDs:** `<scheduleId>_<YYYYMMDD>`, e.g. `66f1c2…_20261029`. Schedule IDs are 20-character `ID.unique()` values, so this is 29 characters, inside Appwrite's 36 limit. Expansion looks rows up by these IDs, not by date, and creates only the missing ones: an occurrence a person moved to another day (posted early, say) still holds its ID, so it isn't made again. One created meanwhile by another run fails the commit with a conflict (409), and the expansion runs again.
- **Voided occurrences stay**, so they block re-creation. "I didn't go this Thursday" means void, never delete.
- **Overridden occurrences** (`overridden = true`) are never deleted or changed by schedule edits.

## The scheduler job

The function has a cron schedule of `5 * * * *` (hourly, at :05, UTC) and runs **asynchronously** with a generous timeout. Appwrite sends each run as `POST /` with the `schedule` trigger. That route refuses a person (`FORBIDDEN`) or a call without a JWT (`UNAUTHENTICATED`), and returns only counts. The steps run in order: expand, auto-post, reminders, summaries, receipt clean-up (step 5, [#163](https://github.com/rojinc/ledgerly/issues/163)), then the nightly check, last. Each processes items in batches of 100, and a run stops taking new items 12 minutes after it began (the timeout is 900 s); anything left is picked up on the next run.

### Step 1: expand due schedules

Query `schedules` where `nextRunAt <= now` (`idx_nextRunAt`, in pages by `$id`). Skip (and clear `nextRunAt` for) schedules in archived groups. For each:

```
today       = localToday(group.timezone, now)
from        = max(startsOn, generatedThrough + 1 day)
end         = min(endsOn, the rule's UNTIL or COUNTth date), or none
to          = min(end ?? ∞, today + horizonDays)
for date in expandSchedule(schedule, from, to, holidays(group.region)):
    no row with id <scheduleId>_<YYYYMMDD> → create it
        kind, description, category, totalCents, inputJson from the template
        status = 'scheduled' (shift, expense, income) or 'due' (bill, with dueOn = date)
        scheduleId, date, createdBy = schedule.createdBy
    a changeable row that differs from the template → update it in place, items replaced
for each changeable row dated from generatedThrough + 1 day on (startsOn when empty)
        whose date the rule no longer has (before startsOn, say):
    dated up to `to`, or after `end` → delete it with its items
generatedThrough = the later of to and its old value
nextRunAt = next local 00:05 in group.timezone (as UTC; 01:05 where the clocks skip midnight),
            or empty once everything up to end exists
```

A **changeable** occurrence is still `scheduled` or `due` and not `overridden`. Voided, edited and posted ones are left as they are, and a changeable one dated after `to` but not after `end` waits until the window reaches it. Creating and reconciling start from the same day, the day after `generatedThrough`. An edit or an end moves `generatedThrough` to yesterday (or later), so they never make, change or delete anything before today: a past occurrence that wasn't posted waits for the user. So expansion brings the occurrences in line with the schedule as it is now, and an edit that stopped partway is put right by the next run, however late it comes: a run after midnight, or after an outage, also brings the days since `generatedThrough` in line, as the edit would have.

Occurrences are written in batches of at most 90 operations per database transaction (a daily rule with a 120-day horizon is 120 rows), with each occurrence's items, in date order. Each batch is guarded ([ledger.md#concurrency](ledger.md#concurrency)):
- it stages its progress (`generatedThrough` up to the last date it reached, and `nextRunAt` in the last batch) on the schedule row;
- it checks the stored schedule is the one it read;
- it guards the group row and the member row of everyone the template names;
- after staging, it checks the rows it updates or deletes are still changeable and have no item it didn't read.

An edit, another run, a member removed or an occurrence changed meanwhile makes it run again with things as they are now. A cron run starts no new batch once its 12 minutes are up; the next run carries on from the progress saved. A schedule that still can't be expanded (a template a member change made invalid, say) keeps its `nextRunAt`, is counted as failed in the run's result, and is tried again next run. Cost grows with the number of schedules that are **due**, not the number of users ([Scaling](scaling.md)).

### Step 2: auto-post

- **Shifts:** status `scheduled`, kind `shift`, `date < localToday`, and the schedule has `autoPost` → post. Shares are built with the same `buildShares()` the `ledger` function uses, and the group's `balances` row is kept the same way ([balances](ledger.md#balances)).
- **Autopay bills:** status `due`, `dueOn <= localToday`, and the schedule has `autoPost` → post with the template's payers, `date = dueOn`.
- **Other `scheduled` kinds** (expense, income): post when `date <= localToday` and `autoPost` is set.
- Edited (`overridden`) occurrences auto-post too, with the edited values. Voided ones never do.
- **Never one made after its own day** (the date of its `$createdAt` in the group's timezone later than its `date`, or a bill's `dueOn`): a run that came late after an edit, or a new schedule that starts in the past, makes past occurrences, and those wait for the user like any past occurrence that wasn't posted. So a run that comes late after an edit never posts a moved week twice (Thursday posted, then Friday made on Saturday). One made on or before its day still posts: an edit on Friday that moves Thursday's posted shift to Fridays makes Friday's, which the user voids if the week is already paid.
- **Never one already reminded about** (`remindedAt` set by step 3's "Shift to confirm"): the owner was asked to confirm it, so it waits for them, also when `autoPost` is turned on later. Turning `autoPost` on posts the past 7 days' occurrences nobody has been reminded about.

Query with `idx_status_date` (autopay bills: `idx_status_dueOn`) for dates from 7 days ago up to the UTC date plus one day (some timezones are ahead), then check each group's local date before posting. Skip transactions in archived groups; they stay as they are. The 7-day floor matters: shifts waiting for manual confirmation stay `scheduled` for as long as the user ignores them, and without a floor every run would re-read all of them. An auto-post occurrence missed by more than 7 days (a long outage) waits for the user.

A schedule whose `nextRunAt` has come is left for now: step 1 hasn't brought its occurrences in line yet (it ran out of time, or failed on it), and a later run posts them once it has. Each occurrence is read again first, and checked again once its row is guarded, so one a person posted, voided or moved to a later day meanwhile is left alone; an edited one posts with its edited values. It is posted with the ledger's own post (`postInTransaction` in `packages/server`, the same guards and writes as `POST /transactions/{id}/post`) as the schedule's creator: they pay when the template names no payers, and they are its `updatedBy`. The activity row has no actor ([data model](data-model.md#activity)). One a finalizing statement covers (`LOCKED`) is skipped until a later run. One that breaks a ledger rule now (a member removed after it was made) is counted as failed, logged with its ID and error code only, and stays `scheduled` for the user. The run's result counts `posted`, `skipped` and `failed`.

### Step 3: reminders

| Reminder | Condition | Sent to |
| --- | --- | --- |
| Bill due soon | status `due`, `dueOn` within 2 days, `remindedAt` empty | joined admins with an account (personal: the owner) |
| Shift to confirm | status `scheduled`, `date < today`, `remindedAt` empty, whether or not its schedule has `autoPost` | group owner |
| Timer still running | status `running`, `startedAt` more than 12h ago, `remindedAt` empty | the person who started it |

Each reminder goes out once. In one database transaction, `remindedAt` is staged first, then the stored row is checked: still the same status, date or `startedAt`, not locked and not reminded. Only then is the email sent, with Resend's idempotency key `reminder-<transactionId>`, before the commit. A row that changed after the page was read gets nothing. One that changes after staging fails the commit, and the next run looks at it again; if the email had gone out, Resend doesn't deliver it twice within 24 hours. A failed send leaves `remindedAt` empty, so the next run tries again, except for an email Resend will never take (a bad address, or the same key with different content), which is marked. Any other failure on one row is counted, and the run carries on. Bill reminders add `dueOn` to the key: a new due date clears `remindedAt` and needs its own reminder.

- **Who gets it:** only an active member with an account and a verified email (`users.get`, so the function has the `users.read` scope). With nobody to send to, `remindedAt` is still set, so the row isn't read every hour.
- **Shift to confirm:** for every `scheduled` shift dated before today in the group's timezone: one with no schedule (nothing posts it), one whose schedule doesn't auto-post, and an auto-post one that step 2 couldn't post by 07:00 (a template a member change broke, a schedule step 1 can't finish, a statement that stayed `finalizing` all night, or one made after its day), so none drops out of the 7-day window unseen. Once reminded, it waits for the owner (step 2). An auto-post shift step 2 can post is posted before any reminder: every hourly run does step 2 before step 3, from the first run after local midnight, and reminders wait until 07:00. The query uses the same 7-day floor as step 2. An auto-post expense or income that step 2 can't post has no reminder of its own; it stays on the calendar for the user.
- **When:** only once it is 07:00 or later in the group's timezone, so nobody gets one in the middle of the night; a later run picks up the rest. Archived groups get none: their rows are marked without an email, since a timer there can't be stopped.
- **Link:** `<APP_URL>/groups/<groupId>/transactions/<transactionId>`.

### Step 4: summary emails

Profiles where `nextSummaryAt <= now`: first move `nextSummaryAt` forward (so a summary goes out at most once), then send the summary for the period that just ended ([ledger reports](ledger.md#reports)). Summaries use the profile's timezone, because they cover all of a person's groups; reminders use the group's. All send times are 07:00 local:

| Frequency | Sent | Covers |
| --- | --- | --- |
| `weekly` | every Monday | the previous Monday to Sunday |
| `fortnightly` | every 14 days, starting on the first Monday 07:00 after the frequency or timezone was last set | the 14 days before (Monday to the Sunday before the send) |
| `monthly` | the 1st of each month | the previous calendar month |

- When `summaryFrequency` changes to a different value, or `timezone` changes, `identity PATCH /profile` sets `nextSummaryAt` to the first send time strictly after now. `none` clears it.
- After a send, the scheduler sets it to the next send time strictly after now: by the table for `weekly` and `monthly`; for `fortnightly`, the old send date plus 14 days, repeated until it is in the future. So a late run skips a missed summary but keeps the cycle.
- The summary covers `summaryPeriod(frequency, D)`, where D is the old `nextSummaryAt`'s local date, so a late run still reports the right period.
- Send times are worked out as local dates, then 07:00 on that date is converted to UTC (as `closeAtFor` does). Never add hours, or DST would move the send time.
- Core's `nextSummaryAt(frequency, timeZone, now, previous?)` and `summaryPeriod(frequency, D)` implement this, so `identity` and the scheduler agree.

The email goes only to a verified account email, and a period with no shares and every balance at 0 sends nothing; either way `nextSummaryAt` still moves forward.

### Step 5: receipt clean-up

Deletes the files in the `receipts` bucket that no transaction lists, using the [`receiptFiles`](data-model.md#receiptfiles) rows the ledger keeps ([permissions](permissions.md#storage)). `now` is when the run started. A run deletes at most 200 files; the rest wait for the next run. Until the [backfill](data-model.md#receiptfiles) has run in the environment, step 5 does nothing: it first reads the [`migrations`](data-model.md#migrations) row `receipt-files-backfill`, once per run.

1. **Never attached:** files in `receipts` with `$createdAt` after `now − 72 h` and at or before `now − 24 h`, ordered by `$id`, with their `receiptFiles` rows read a page at a time. `listFiles` pages with `Query.cursorAfter` (it doesn't take `greaterThan('$id')`), and a deleted file can't be a cursor. So the cursor is the last file on the page that this pass didn't delete; when it deleted the whole page, the next query starts from the top again, and those files are gone by then. A query that fails ends the pass for this run. A file that has a row is left to pass 2. For each file with no row:
   1. One database transaction creates the row with `detachedAt` set to the file's `$createdAt` and `deletingAt = now`. If the row exists by then (409), the ledger attached the file first, and it's skipped.
   2. Delete the file. One that's already gone is skipped.

   This pass runs first because it can't wait: a file it doesn't reach within the 72 hours is never deleted (it stays until a transaction lists it and takes it off). Each run looks at 48 hours of uploads, so files are still found after a scheduler outage of up to 48 hours.
2. **Taken off every transaction, and leftovers:** rows with `detachedAt <= now − 24 h` (`idx_detachedAt`), paged by `$id`. For each row:
   1. If `deletingAt` is empty, one database transaction stages `deletingAt = now`, then checks that the stored row still lists no transaction and has the same `detachedAt`. If not, it rolls back and skips the row: the file was attached again.
   2. Delete the file. One that's already gone is skipped.
   3. Delete the row once its `deletingAt` is at least an hour old, which is usually on a later run, and always after the file. One that's already gone is skipped.

   A run that stops between these steps leaves `deletingAt` and `detachedAt` set, so a later run finishes the job.

**Races with an attach:**
- an attach that commits first makes the step's check or commit fail, and the file stays;
- an attach that commits later finds `deletingAt` and is refused, even one that read the rows before the step made or marked the row, because it reads them again after staging. The row is kept until its `deletingAt` is at least an hour old, which is far longer than any ledger request (15 s timeout), so no attach can miss both the row and the missing file.

Anything that fails for one file or row is counted and left for the next run, and the step carries on. A Storage error is never taken for a database conflict. The run returns `receipts: { deleted, skipped, failed }` and logs nothing per file.

### Step 6: nightly check

Runs last, in what's left of the run's budget. It takes groups where `nextCheckAt` is empty or `<= now` (`idx_nextCheckAt`), in pages of 100 by `$id` as step 1 does, until the budget is used. Archived groups are checked too. A group whose team is gone (a [purge](identity-and-invites.md#deleting-an-account-m4) in progress) is skipped. A check reads, apart from the two repairs below and its `nextCheckAt`: it never writes shares, transactions or members, and it doesn't finish merges (a lead decision for v1: only `/claim` carries a merge on).

**Reading a group whole.** It reads the group's `rev`, then the group's members, posted transactions (`idx_group_status_date`), shares and `balances` row, then `rev` again. Every write of shares changes `rev` ([concurrency](ledger.md#concurrency)), so the same value means nothing changed in between. Otherwise it reads again, up to 3 times, then leaves the group for the next run (counted as `busy`).

**Checks.** Each finding is one error log line with the event, the `groupId`, and the `transactionId`, `membershipId` or rule. IDs only ([personal data](security-and-privacy.md#personal-data)).
- The `balances` row, if the group has one, equals the one built fresh from the shares (core `balancesFromShares()`).
- Every posted transaction passes `assertShareInvariants()` (I-1, I-2, I-4, I-5), with each of its shares' persons counted as a member, so I-3 below doesn't stop the other checks.
- Every share's person has a member row in the group (I-3). A share of a person whose merge isn't finished (`mergedInto` set, and the person still has an identity) counts as `merging`, not as broken: a merge cut off partway leaves shares on P ([merging](identity-and-invites.md#merging-two-persons)). Once P has no identity, a share left on P is broken.
- Every share belongs to a posted transaction of this group (I-6).

Broken shares or transactions are reported, never fixed. They're fixed by hand, with adjustments.

**Repairing the `balances` row.** A missing row (the backfill, or one deleted since) or a wrong one is rewritten in one database transaction: stage the group's guard write, sum the shares after it, then write the row. A wrong row also logs an error. A write of shares that lands meanwhile fails one of the two commits.

**The team.** A team membership is removed when all of these hold:
- The user's person has no `active` or `left` member row in the group, or only a `left` row they left on their own since that member row was created (`leftOnTheirOwn()`: their own `member.left` is the newest of their `member.left` and `member.joined` rows, [leaving](permissions.md#leaving-a-group)).
- The person isn't being deleted (`deletedAt` empty): [account deletion](identity-and-invites.md#deleting-an-account-m4) leaves the team as its own last step for each group, and decides a rerun from it.
- The membership is more than 1 hour old, because joining and merging add the team membership before the member row ([joining](identity-and-invites.md#joining-a-group)).
- Reading the member rows again just before removing still shows this.

After removing it, the check reads the member rows once more, and adds the membership back if a join or a merge made the person a joined member meanwhile. This catches a join, a merge or a leave that stopped between its Teams call and its database transaction. A membership that's already gone counts as removed. These are the scheduler's only team writes (the `teams.write` scope), and no route that people call reaches them.

**When it's done.** A group whose check finished gets `nextCheckAt` = 03:00 tomorrow in the group's time zone, worked out as a local date and then converted to UTC, as for summaries. So does a group the budget cut off, with its ID logged: tomorrow's check starts it again from the start, and it can't hold up the groups after it on every run. A group left as `busy` gets `nextCheckAt` one hour later, so a later run tries it again soon. Writing `nextCheckAt` changes the group row, so a ledger write that overlaps it runs once more. Runs that overlap are safe: the checks only read, the repairs are guarded, and the run returns counts only. Until alerting exists, the error lines are the alert.

## Schedule routes

All on the `scheduler` function. Shapes are in [Functions API](functions-api.md#scheduler).

| Route | What it does |
| --- | --- |
| `POST /schedules` | Validate, create, then expand right away so the calendar fills in at once. `startsOn` is at most 31 days before local today (`VALIDATION_FAILED`, "The start date can be at most 31 days ago."): the past occurrences are made at once and wait for the user (step 2 never posts them), so a mistyped year can't make years of them. The template is checked against the ledger rules with a trial occurrence on `startsOn`, with the schedule's creator as the payer when it names none; an occurrence stores no payer, so the person who posts it pays then (the creator when step 2 posts it). A retry by the same person with the same content finishes the expansion; the same `id` otherwise is `CONFLICT` |
| `PATCH /schedules/{id}` | Update. Save the new rule and template, with `generatedThrough` set to yesterday (it stays empty for a schedule that never expanded, which starts from `startsOn` like a new one), then expand again from local today, never filling in past dates, even when reopening an ended schedule: changeable occurrences are updated in place, deleted when the new rule no longer has their date (before a later `startsOn`, say) or they are after its end, and created where missing. `created`, `updated` and `removed` count the ones created, updated in place and deleted. A changed `startsOn` has the same 31-day limit as on `POST`. The group and kind can't change (`VALIDATION_FAILED`) |
| `POST /schedules/{id}/end` | Set `endsOn`. Delete non-overridden future occurrences after it (from the later of the day after `endsOn` and local today; a past one that wasn't posted waits for the user). It never checks the template, so a schedule can always be ended. It sets `nextRunAt` to now, and `generatedThrough` to no earlier than yesterday, so the next cron run deletes any it didn't get to (a timeout, say), or carries on up to a later `endsOn` than before, from today on |
| `DELETE /schedules/{id}` | Only if it has no posted occurrences; otherwise use end. Deletes all its occurrences, voided and edited ones included (last), with their items. One that stops partway (a timeout, or a post meanwhile) can leave some; voided and edited ones go last so they keep blocking their dates |
| `POST /schedules/preview` | Return the next `count` dates (default 10) for an unsaved rule, from the later of `startsOn` and today in the group's timezone, for the form preview. `skipped` lists the dates left out on the way, each with `reason: 'exdate'` or `'holiday'` (`exdate` when both) |

Changes to occurrences themselves (edit, void, post) go through the `ledger` function. Editing an occurrence sets `overridden = true`.

Creating or editing a schedule guards the group row and the member row of everyone its template names, like a ledger write ([ledger.md#concurrency](ledger.md#concurrency)). A template can't commit just after a member's removal was checked, and a removal can't commit just after the template. Every database transaction of these routes that writes occurrences or a schedule's rule guards the group row too, so none lands after an archive. Deleting occurrences stages the deletes, then checks the stored rows. An edit or an end keeps an occurrence edited, posted or voided meanwhile. A delete removes edited and voided ones anyway; one posted meanwhile stops it with `VALIDATION_FAILED`, and the schedule should be ended instead. Schedule templates can't have receipts ([functions-api.md](functions-api.md#scheduler)).

Creating or editing a schedule sets its `nextRunAt` to now in the same transaction that saves it, so if the expansion stops partway (a timeout, or a race lost twice), the next cron run finishes it, with the occurrences from where it stopped brought in line with the new rule. Deleting occurrences also checks their items again after staging, so an item added meanwhile isn't left without its transaction.

## Timer shifts

- `ledger POST /timer/start` (only the group's owner, the worker a shift pays) creates a `shift` with status `running`, `startedAt = now`, `date = localToday`, the local start time as `startTime`, 0 minutes, and the body's rate, else the group's default rate. The description defaults to "Shift". It has no shares until it stops ([I-6](ledger.md#invariants)). Like other ledger writes, it's `LOCKED` while a statement covering today is finalizing.
- `ledger POST /timer/stop` sets the end time (`endTime`), works out minutes (the whole minutes since `startedAt`, minus break minutes) and posts. The shift keeps the date it started on, even past midnight.
  - A break longer than the time the timer ran is `VALIDATION_FAILED`.
  - So are more than 1440 paid minutes. A timer left running that long is voided and added by hand.
- Only one running timer per person, across all their groups. Starting another returns `CONFLICT` with the running one's ID in `details.transactionId`.
  - Every start writes a fresh `rev` to the group row and to the person's personal group row ([concurrency](ledger.md#concurrency)). So of two starts at once, in one group or in two, only one succeeds.
  - A timer left running in an archived group doesn't count, because it can no longer be stopped or voided.
- A retried start with the same `id` returns the timer. A retried stop with the same break returns the posted shift.
- A group can't be archived while a timer is running in it (`CONFLICT`). The archive stages its write to the group row, then checks for running timers. A start writes the group row too, so of a start and an archive at the same moment, whichever commits second fails or runs again: neither leaves a running timer in an archived group.
