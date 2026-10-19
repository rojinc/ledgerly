# Scheduling

Schedules create transactions automatically: a Thursday shift, weekly rent, a monthly phone bill. The `scheduler` function also runs every other time-based job: auto-posting, reminders and summary emails.

## What a schedule is

A row in `schedules` ([data model](data-model.md#schedules)) with:

- a **template**: the transaction to create (kind, description, amount or minutes × rate, payers, split),
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

The function has a cron schedule of `5 * * * *` (hourly, at :05, UTC) and runs **asynchronously** with a generous timeout. Appwrite sends each run as `POST /` with the `schedule` trigger. That route refuses a person (`FORBIDDEN`) or a call without a JWT (`UNAUTHENTICATED`), and returns only counts. The steps run in order. Each processes items in batches of 100, and a run stops taking new items 12 minutes after it began (the timeout is 900 s); anything left is picked up on the next run.

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
for each changeable row dated from max(today, generatedThrough + 1 day) on
        whose date the rule no longer has (before startsOn, say):
    dated up to `to`, or after `end` → delete it with its items
generatedThrough = to
nextRunAt = next local 00:05 in group.timezone (as UTC), or empty once everything up to end exists
```

A **changeable** occurrence is still `scheduled` or `due`, not `overridden`, and dated today or later in the group's timezone. Voided, edited and posted ones are left as they are, and so is a past one that wasn't posted: it waits for the user. A changeable one dated after `to` but not after `end` waits until the window reaches it. So expansion brings the occurrences in line with the schedule as it is now, and an edit that stopped partway is put right by the next run.

Occurrences are written in batches of at most 90 operations per database transaction (a daily rule with a 120-day horizon is 120 rows), with each occurrence's items, in date order. Each batch is guarded ([ledger.md#concurrency](ledger.md#concurrency)):
- it stages its progress (`generatedThrough` up to the last date it reached, and `nextRunAt` in the last batch) on the schedule row;
- it checks the stored schedule is the one it read;
- it guards the group row and the member row of everyone the template names;
- after staging, it checks the rows it updates or deletes are still changeable and have no item it didn't read.

An edit, another run, a member removed or an occurrence changed meanwhile makes it run again with things as they are now. A cron run starts no new batch once its 12 minutes are up; the next run carries on from the progress saved. A schedule that still can't be expanded (a template a member change made invalid, say) keeps its `nextRunAt`, is counted as failed in the run's result, and is tried again next run. Cost grows with the number of schedules that are **due**, not the number of users ([Scaling](scaling.md)).

### Step 2: auto-post

- **Shifts:** status `scheduled`, kind `shift`, `date < localToday`, and the schedule has `autoPost` → post. Shares are built with the same `buildShares()` the `ledger` function uses.
- **Autopay bills:** status `due`, `dueOn <= localToday`, and the schedule has `autoPost` → post with the template's payers, `date = dueOn`.
- **Other `scheduled` kinds** (expense, income): post when `date <= localToday` and `autoPost` is set.
- Edited (`overridden`) occurrences auto-post too, with the edited values. Voided ones never do.

Query with `idx_status_date` (autopay bills: `idx_status_dueOn`) for dates from 7 days ago up to the UTC date plus one day (some timezones are ahead), then check each group's local date before posting. Skip transactions in archived groups; they stay as they are. The 7-day floor matters: shifts waiting for manual confirmation stay `scheduled` for as long as the user ignores them, and without a floor every run would re-read all of them. An auto-post occurrence missed by more than 7 days (a long outage) waits for the user.

### Step 3: reminders

| Reminder | Condition | Sent to |
| --- | --- | --- |
| Bill due soon | status `due`, `dueOn` within 2 days, `remindedAt` empty | joined admins with an account (personal: the owner) |
| Shift to confirm | status `scheduled`, `date < today`, schedule has no `autoPost`, `remindedAt` empty | group owner |
| Timer still running | status `running`, `startedAt` more than 12h ago, `remindedAt` empty | the person who started it |

Each reminder goes out once. In one database transaction, `remindedAt` is staged first, then the stored row is checked: still the same status, date or `startedAt`, not locked and not reminded. Only then is the email sent, with Resend's idempotency key `reminder-<transactionId>`, before the commit. A row that changed after the page was read gets nothing. One that changes after staging fails the commit, and the next run looks at it again; if the email had gone out, Resend doesn't deliver it twice within 24 hours. A failed send leaves `remindedAt` empty, so the next run tries again, except for an email Resend will never take (a bad address, or the same key with different content), which is marked. Any other failure on one row is counted, and the run carries on. Bill reminders add `dueOn` to the key: a new due date clears `remindedAt` and needs its own reminder.

- **Who gets it:** only an active member with an account and a verified email (`users.get`, so the function has the `users.read` scope). With nobody to send to, `remindedAt` is still set, so the row isn't read every hour.
- **Shift to confirm:** also for a `scheduled` shift that has no schedule, since nothing will post it. The shift's date must be before today in the group's timezone. The query uses the same 7-day floor as step 2.
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

## Schedule routes

All on the `scheduler` function. Shapes are in [Functions API](functions-api.md#scheduler).

| Route | What it does |
| --- | --- |
| `POST /schedules` | Validate, create, then expand right away so the calendar fills in at once. The template is checked against the ledger rules with a trial occurrence on `startsOn`, with the schedule's creator as the payer when it names none; an occurrence stores no payer, so the person who posts it pays then (the creator when step 2 posts it). A retry by the same person with the same content finishes the expansion; the same `id` otherwise is `CONFLICT` |
| `PATCH /schedules/{id}` | Update. Save the new rule and template, with `generatedThrough` moved back to yesterday if it is later, then expand again from local today: changeable occurrences are updated in place, deleted when the new rule no longer has their date (before a later `startsOn`, say) or they are after its end, and created where missing. `created` and `removed` count the ones created and deleted; one updated in place counts as neither. The group and kind can't change (`VALIDATION_FAILED`) |
| `POST /schedules/{id}/end` | Set `endsOn`. Delete non-overridden future occurrences after it (from the later of the day after `endsOn` and local today; a past one that wasn't posted waits for the user). It never checks the template, so a schedule can always be ended; a later `endsOn` than before carries on at the next run |
| `DELETE /schedules/{id}` | Only if it has no posted occurrences; otherwise use end. Deletes all its occurrences, voided and edited ones included (last), with their items. One that stops partway (a timeout, or a post meanwhile) can leave some; voided and edited ones go last so they keep blocking their dates |
| `POST /schedules/preview` | Return the next `count` dates (default 10) for an unsaved rule, from the later of `startsOn` and today in the group's timezone, for the form preview. `skipped` lists the dates left out on the way, each with `reason: 'exdate'` or `'holiday'` (`exdate` when both) |

Changes to occurrences themselves (edit, void, post) go through the `ledger` function. Editing an occurrence sets `overridden = true`.

Creating or editing a schedule guards the group row and the member row of everyone its template names, like a ledger write ([ledger.md#concurrency](ledger.md#concurrency)). A template can't commit just after a member's removal was checked, and a removal can't commit just after the template. Every database transaction of these routes that writes occurrences or a schedule's rule guards the group row too, so none lands after an archive. Deleting occurrences stages the deletes, then checks the stored rows. An edit or an end keeps an occurrence edited, posted or voided meanwhile. A delete removes edited and voided ones anyway; one posted meanwhile stops it with `VALIDATION_FAILED`, and the schedule should be ended instead. Schedule templates can't have receipts yet, like `POST /transactions`.

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
