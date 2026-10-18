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

`INTERVAL` counts from the week (weeks start on Monday) or month of `startsOn`: "every other Tuesday" starting on a Wednesday first falls 13 days later. `COUNT` counts dates before `exdates` and holidays are taken out, as RFC 5545 does.

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

- **Deterministic occurrence IDs:** `<scheduleId>_<YYYYMMDD>`, e.g. `66f1c2…_20261029`. Schedule IDs are 20-character `ID.unique()` values, so this is 29 characters, inside Appwrite's 36 limit. Creating a row that already exists fails with a conflict (409), which the scheduler ignores.
- **Voided occurrences stay**, so they block re-creation. "I didn't go this Thursday" means void, never delete.
- **Overridden occurrences** (`overridden = true`) are never deleted or changed by schedule edits.

## The scheduler job

The function has a cron schedule of `5 * * * *` (hourly, at :05, UTC) and runs **asynchronously** with a generous timeout. Appwrite sends each run as `POST /` with the `schedule` trigger; that route refuses anything else (`FORBIDDEN`) and returns only counts. The steps run in order. Each processes items in batches of 100, and a run starts no new batch 12 minutes after it began (the timeout is 900 s); anything left is picked up on the next run.

### Step 1: expand due schedules

Query `schedules` where `nextRunAt <= now`, ordered by `nextRunAt`. Skip (and clear `nextRunAt` for) schedules in archived groups. For each:

```
today       = localToday(group.timezone, now)
from        = max(startsOn, generatedThrough + 1 day)
to          = min(endsOn ?? ∞, today + horizonDays)
for date in expandSchedule(schedule, from, to, holidays(group.region)):
    create transaction id=<scheduleId>_<YYYYMMDD>
        kind, description, category, totalCents, inputJson from the template
        status = 'scheduled' (shift, expense, income) or 'due' (bill, with dueOn = date)
        scheduleId, date, createdBy = schedule.createdBy; ignore 409
generatedThrough = to
nextRunAt = next local 00:05 in group.timezone (as UTC), or empty if endsOn < today
```

Occurrences are written in batches of at most 90 operations per database transaction (a daily rule with a 120-day horizon is 120 rows). Cost grows with the number of schedules that are **due**, not the number of users ([Scaling](scaling.md)).

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

Each reminder goes out once: it is sent with Resend's idempotency key `reminder-<transactionId>`, then `remindedAt` is set. If the run stops in between, the next run sends it again with the same key, and Resend doesn't deliver it twice within 24 hours. A failed send leaves `remindedAt` empty, so the next run tries again.

- **Who gets it:** only a joined member with an account and a verified email (`users.get`, so the function has the `users.read` scope). With nobody to send to, `remindedAt` is still set, so the row isn't read every hour.
- **Shift to confirm:** also for a `scheduled` shift that has no schedule, since nothing will post it. The shift's date must be before today in the group's timezone. The query uses the same 7-day floor as step 2.
- **When:** only once it is 07:00 or later in the group's timezone, so nobody gets one in the middle of the night; a later run picks up the rest. Archived groups get none.
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
| `POST /schedules` | Validate, create, then expand right away so the calendar fills in at once |
| `PATCH /schedules/{id}` | Update. Delete future occurrences that are still `scheduled`/`due` and not `overridden` (date ≥ local today), reset `generatedThrough` to yesterday, expand again |
| `POST /schedules/{id}/end` | Set `endsOn`. Delete non-overridden future occurrences after it |
| `DELETE /schedules/{id}` | Only if it has no posted occurrences; otherwise use end |
| `POST /schedules/preview` | Return the next `count` dates (default 10) for an unsaved rule, from the later of `startsOn` and today in the group's timezone, for the form preview. `skipped` lists the dates left out on the way, each with `reason: 'exdate'` or `'holiday'` (`exdate` when both) |

Changes to occurrences themselves (edit, void, post) go through the `ledger` function. Editing an occurrence sets `overridden = true`.

## Timer shifts

- `ledger POST /timer/start` creates a `shift` with status `running`, `startedAt = now`, `date = localToday` and the group's default rate.
- `ledger POST /timer/stop` sets the end time, works out minutes (minus break minutes) and posts.
- Only one running timer per person. Starting another returns `CONFLICT` with the running one's ID.
