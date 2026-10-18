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

Any valid `RRULE` is accepted from the API, but the UI only offers these.

## Expanding occurrences

`expandSchedule(schedule, from, to, holidays) → LocalDate[]` in `packages/core` is pure and tested.

**Timezone rule:** expand in *floating* dates. Turn `YYYY-MM-DD` into `Date.UTC(y, m - 1, d)`, run `rrule` in UTC, and turn the results back into `YYYY-MM-DD`. Never let the server's or browser's timezone touch a local date. This is the classic bug that moves Thursday to Wednesday.

Skip a date when:

- it is before `startsOn` or after `endsOn`,
- it is in `exdates`,
- `skipPublicHolidays` is on and it is a public holiday in the group's `region`.

### Public holidays

- Use `date-holidays`: region `AU-NSW` becomes `new Holidays('AU', 'NSW')`.
- Count only holidays of type `public`. Ignore `bank`, `school`, `observance` and so on.
- Check with the local date at noon, to avoid edge cases around midnight.
- Users can still add a shift on a holiday by hand, or skip any other day with `exdates`.

## Idempotency

The scheduler may run twice, overlap with itself or crash halfway. None of that may create duplicates.

- **Deterministic occurrence IDs:** `<scheduleId>_<YYYYMMDD>`, e.g. `66f1c2…_20261029`. Schedule IDs are 20-character `ID.unique()` values, so this is 29 characters, inside Appwrite's 36 limit. Creating a row that already exists fails with a conflict (409), which the scheduler ignores.
- **Voided occurrences stay**, so they block re-creation. "I didn't go this Thursday" means void, never delete.
- **Overridden occurrences** (`overridden = true`) are never deleted or changed by schedule edits.

## The scheduler job

The function has a cron schedule of `5 * * * *` (hourly, at :05, UTC) and runs **asynchronously** with a generous timeout. Each step processes items in batches of 100 and stops when its time budget is used up; anything left is picked up on the next run.

### Step 1: expand due schedules

Query `schedules` where `nextRunAt <= now`, ordered by `nextRunAt`. For each:

```
today       = localToday(group.timezone)
from        = max(startsOn, generatedThrough + 1 day)
to          = min(endsOn ?? ∞, today + horizonDays)
for date in expandSchedule(schedule, from, to, holidays(group.region)):
    create transaction id=<scheduleId>_<YYYYMMDD>
        kind, description, category, totalCents, inputJson from the template
        status = 'scheduled' (shift, expense, income) or 'due' (bill, with dueOn = date)
        scheduleId, date; ignore 409
generatedThrough = to
nextRunAt = next local 00:05 in group.timezone (as UTC), or empty if endsOn < today
```

Cost grows with the number of schedules that are **due**, not the number of users ([Scaling](scaling.md)).

### Step 2: auto-post

- **Shifts:** status `scheduled`, kind `shift`, `date < localToday`, and the schedule has `autoPost` → post. Shares are built with the same `buildShares()` the `ledger` function uses.
- **Autopay bills:** status `due`, `dueOn <= localToday`, and the schedule has `autoPost` → post with the template's payers, `date = dueOn`.
- **Other `scheduled` kinds** (expense, income): post when `date <= localToday` and `autoPost` is set.

Query with `idx_status_date` using the UTC date plus one day (some timezones are ahead), then check each group's local date before posting.

### Step 3: reminders

| Reminder | Condition | Sent to |
| --- | --- | --- |
| Bill due soon | status `due`, `dueOn` within 2 days, `remindedAt` empty | group admins (personal: the owner) |
| Shift to confirm | status `scheduled`, `date < today`, schedule has no `autoPost`, `remindedAt` empty | group owner |
| Timer still running | status `running`, `startedAt` more than 12h ago, `remindedAt` empty | the person who started it |

Set `remindedAt` in the same write that queues the email, so each reminder goes out once.

### Step 4: summary emails

Profiles where `nextSummaryAt <= now`: send the summary for the period that just ended ([ledger reports](ledger.md#reports)), then move `nextSummaryAt` forward by the user's frequency at 07:00 in their timezone.

## Schedule routes

All on the `scheduler` function. Shapes are in [Functions API](functions-api.md#scheduler).

| Route | What it does |
| --- | --- |
| `POST /schedules` | Validate, create, then expand right away so the calendar fills in at once |
| `PATCH /schedules/{id}` | Update. Delete future occurrences that are still `scheduled`/`due` and not `overridden` (date ≥ local today), reset `generatedThrough` to yesterday, expand again |
| `POST /schedules/{id}/end` | Set `endsOn`. Delete non-overridden future occurrences after it |
| `DELETE /schedules/{id}` | Only if it has no posted occurrences; otherwise use end |
| `POST /schedules/preview` | Return the next N dates for an unsaved rule, including skipped holidays and why, for the form preview |

Changes to occurrences themselves (edit, void, post) go through the `ledger` function. Editing an occurrence sets `overridden = true`.

## Timer shifts

- `ledger POST /timer/start` creates a `shift` with status `running`, `startedAt = now`, `date = localToday` and the group's default rate.
- `ledger POST /timer/stop` sets the end time, works out minutes (minus break minutes) and posts.
- Only one running timer per person. Starting another returns `CONFLICT` with the running one's ID.
