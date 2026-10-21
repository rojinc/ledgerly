# Nightly check

The runbook for M4's first exit criterion: **the nightly invariant check is clean for 2 weeks** ([roadmap](../planning/roadmap.md), [#510](https://github.com/rojinc/ledgerly/issues/510)). The 2 weeks are counted from Deploy run 174, whose first scheduler run was at 02:42Z on 2026-10-21 ([#299](https://github.com/rojinc/ledgerly/issues/299) section 1). Each read confirms one stretch of time, from where the last read ended up to now.

**Who runs what:**
- **The owner** makes the key and deletes it at the end ([D-015](../architecture/decisions.md#d-015-the-lead-agent-runs-the-project-day-to-day)).
- **The lead** runs the reads and posts each result.
- **No other agent** runs any of it (AGENTS.md).

**Nothing here writes.** Every command lists runs or rows.

## What the check leaves behind

The scheduler runs every 60 minutes, and step 6 checks the groups that are due in what's left of the run's 12-minute budget ([step 6](../architecture/scheduling.md#step-6-nightly-check)). A scheduled run is async, so its response, with the run's counts, isn't kept. **Its log lines are the whole record:**

| Event | Means |
| --- | --- |
| `nightly_check_finding` | a broken rule, with `groupId`, `rule` and the `transactionId` when it's one transaction's |
| `nightly_check_failed` | a group's check threw, with `groupId` and the error's name as `cause`; the group stays due, so it's tried again next run |
| `nightly_check_cut_off` | the budget ran out while this group was being checked; it's checked again tomorrow |
| `team_membership_removed` | a stale team membership was removed, with `groupId` and `membershipId` |

Every run also writes one line for its request, with `route` and `status` ([conventions](conventions.md#functions)), which shows that the run's lines are there to read. The functions write with `console`, and the run's lines can land in its `logs` or its `errors` whatever their level, so B reads both.

A group that's due is checked, logged as one of the events above, put off as `busy` (tried an hour later, with no line), skipped while a purge deletes it, or not reached because the budget ran out first. The last three stay due with no line. **So the runs' lines, plus the groups still overdue now (C), cover every group.**

**How long the logs are kept.** Appwrite keeps execution logs for 24 hours on the Free plan and 7 days on Pro ([executions](https://appwrite.io/docs/products/functions/executions)). `ledgerly-dev`'s organisation is on the GitHub Student Pack plan ([function settings](environments-and-deploys.md#function-settings)), whose retention isn't documented. Until the owner confirms it ([#3](https://github.com/rojinc/ledgerly/issues/3)), plan for Free's 24 hours, the shortest: **read within 23 hours of the last read's `to`.** A run whose logs are gone can't be confirmed, and B shows it: that run isn't counted as logged, so the read fails.

## Before you start

- **Tools, the checkout, and pointing the CLI at dev:** as in [first deploy](first-deploy.md#before-you-start), with this key instead of the one-off checks key.
- **The key** (owner: Appwrite → Overview → Integrations → API keys) has only `execution.read` and `rows.read`, and expires the day after the 2 weeks end. If a command fails with `missing scopes (["…"])`, the server is naming the scope it accepts there: add that one.
- **Print IDs, never names or raw log lines.** Every command below prints only IDs, counts, times, event names and error names.

## A read

Set the window. `FROM` is the `to` of the last result posted on #299. The first read starts at Deploy run 174's `DEPLOYED_AT`, and **the lead runs it on 2026-10-21 at about 08:00Z**: it confirms those first hours, and its `logged N of N` shows at once whether the logs last that long. The next read comes within 23 hours of its `to`. `TO` is 20 minutes ago, so every run in the window has finished: a run can take up to 15 minutes.

```bash
FROM=2026-10-21T02:38:27Z                     # the last result's "to"
TO=$(jq -nr 'now - 1200 | floor | todate')    # 20 minutes ago, in UTC
```

Fetch the scheduler's scheduled runs, newest first: 3 pages of 100, which is 12 days of runs.

```bash
RUNS=$(mktemp)
for offset in 0 100 200; do
  ( set -o pipefail
    appwrite functions list-executions --function-id scheduler --json \
      --queries '{"method":"equal","attribute":"trigger","values":["schedule"]}' \
      --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
      --queries '{"method":"limit","values":[100]}' \
      --queries "{\"method\":\"offset\",\"values\":[$offset]}" \
      | jq -c '(.executions // [])[]' ) >> "$RUNS" || { echo "FETCH FAILED at offset $offset"; break; }
done
```

- **`FETCH FAILED`:** stop, delete the runs (`rm -f "$RUNS"`), and post the CLI's error on #96. A read without every page can't pass.
- **The server refuses the order:** use `{"method":"orderDesc","attribute":"$id"}`, as in [4a](first-deploy.md#4a-the-hourly-runs).

To read one run's lines, for A's or B's "if it fails", print only these fields:

```bash
appwrite functions get-execution --function-id scheduler --execution-id <id> --json \
  | jq -r '((.errors // "") + "\n" + (.logs // "")) | split("\n")[] | fromjson? | objects
      | "\(.event // .route) \(.status // "-") \(.code // "-") \(.cause // "-") \(.groupId // "-")"'
```

### A. The runs

```bash
jq -rs --arg from "$FROM" --arg to "$TO" '
  def at: .["$createdAt"][0:19] + "Z";
  unique_by(.["$id"]) as $all
  | ([$all[] | select(at < $from) | at] | max // $from) as $before
  | [$all[] | select(at >= $from and at < $to)] | sort_by(at)
  | ([$before] + map(at) + [$to] | map(fromdateiso8601)) as $t
  | "window \((($to | fromdateiso8601) - ($from | fromdateiso8601)) / 360 | floor / 10) h · runs \(length) · not ok \(map(select(.status != "completed" or .responseStatusCode != 200)) | length) · longest gap \([range(1; $t | length) as $i | $t[$i] - $t[$i - 1]] | max / 60 | floor) min · longest run \(map(.duration // 0) | max // 0 | floor) s",
    (.[] | select(.status != "completed" or .responseStatusCode != 200) | "not ok \(.["$id"]) \(at) \(.status) \(.responseStatusCode // "-")")
' "$RUNS"
```

The longest gap is measured from the last run before the window, so a gap across two reads counts whole.

- **Pass:** `not ok 0`, and a longest gap of at most 125 minutes: one run Appwrite skipped is fine, since the groups due then stay due for the next run.
- **Too early:** a `not ok` run that's `waiting` or `processing` hasn't finished. Run the read again later with the same `FROM`.
- **If it fails:**
  - **A run `failed`, or not 200:** read its lines (above) and post the execution ID and what they print on #96. A run that failed part way may have lost the lines of the groups it checked, so the window can't be confirmed.
  - **A longer gap, or no runs:** the scheduler didn't run for 2 hours or more. Post the times on #96.
- **A longest run of 700 s or more** means a run used most of its budget, and groups after it may have waited for the next run. It isn't a fail, since C shows any group still waiting. Post it if it repeats.

### B. The lines

```bash
jq -rs --arg from "$FROM" --arg to "$TO" '
  def at: .["$createdAt"][0:19] + "Z";
  def lines: ((.errors // "") + "\n" + (.logs // "")) | split("\n") | map(fromjson? | objects);
  def n($e): map(select(.event == $e)) | length;
  [unique_by(.["$id"])[] | select(at >= $from and at < $to)] as $runs
  | [$runs[] | at as $at | lines[]
      | select(.event | IN("nightly_check_finding", "nightly_check_failed", "nightly_check_cut_off", "team_membership_removed"))
      | . + {at: $at}]
  | "logged \([$runs[] | select(lines | any(.route))] | length) of \($runs | length) runs · findings \(n("nightly_check_finding")) · failed \(n("nightly_check_failed")) · cut off \(n("nightly_check_cut_off")) · removed \(n("team_membership_removed"))",
    (.[] | "\(.at) \(.event) \(.groupId // "-") \(.rule // "-") \(.transactionId // .membershipId // .cause // "-")")
' "$RUNS"
rm "$RUNS"
```

It prints how many runs still have their lines, the counts, then one line per event: the run's time, the event, the group ID, the rule, and the transaction ID, membership ID or error name.

- **Pass:** `logged N of N runs` (the same number twice), and `findings 0 · failed 0 · cut off 0`.
- **`removed`** doesn't fail the read: it's a repair of the team, not a broken invariant. Post each line's IDs.
- **If it fails:**
  - **Fewer runs logged than runs:** those runs' lines are gone or weren't returned, so the window can't be confirmed.
  - **A finding** is fixed by hand, with adjustments ([step 6](../architecture/scheduling.md#step-6-nightly-check)). Post the lines on #96. A `balances_row` finding has already been repaired by the check, which rebuilt the row, but it still fails the read: something wrote a wrong row.
  - **A failed group** is tried every run, so it repeats. Post its ID and `cause`.
  - **A cut-off group** wasn't checked in this window, and is checked again tomorrow. Post its ID; several in a row mean step 6 runs out of budget.

### C. Groups overdue now

A group still due more than 2 hours after its time wasn't checked by the runs since. That covers a group no run reached, one left `busy` or failed, and one being purged. C is a point in time, so it's run at each read and can't be run for the past.

```bash
STALE=$(jq -nr 'now - 7200 | floor | todate')
appwrite tablesdb list-rows --database-id main --table-id groups --json \
  --queries "{\"method\":\"lessThan\",\"attribute\":\"nextCheckAt\",\"values\":[\"$STALE\"]}" \
  --queries '{"method":"limit","values":[100]}' \
  | jq -r '(.rows // [])[] | "overdue \(.["$id"]) due \(.nextCheckAt) deleting \(.deletingAt // "-") archived \(.archivedAt // "-")"'
appwrite tablesdb list-rows --database-id main --table-id groups --json \
  --queries '{"method":"isNull","attribute":"nextCheckAt"}' \
  --queries '{"method":"limit","values":[100]}' \
  | jq -r --arg stale "$STALE" '(.rows // [])[] | select(.["$createdAt"][0:19] + "Z" < $stale)
      | "overdue \(.["$id"]) due never deleting \(.deletingAt // "-") archived \(.archivedAt // "-")"'
```

**A purge under way** is pending, not a fail. Both purges, a group delete and an account deletion's, archive the group and delete its team first, and step 6 leaves the group due while its rows go ([purging a group](../architecture/identity-and-invites.md#purging-a-group)). So an overdue group is **pending** when it has `deletingAt` set, or has `archivedAt` set and wasn't pending at the last read.

- **Pass:** no lines, or only pending groups.
- **If it fails:** post the IDs on #96. **A group pending at two reads in a row** fails the read: it's an archived group nobody checked, or a purge that's stuck.

### D. Merges that don't finish

A merge that can't finish is tried every hour by `identity`'s scheduled run, and each run logs it as `merge_carries_on`. That line is a `log`, not an error, so it shows only in the run's `.logs` ([finishing merges](../architecture/identity-and-invites.md#finishing-merges)). D lists those merges and any `merge_run_failed`, from the same window.

```bash
IDRUNS=$(mktemp)
for offset in 0 100 200; do
  ( set -o pipefail
    appwrite functions list-executions --function-id identity --json \
      --queries '{"method":"equal","attribute":"trigger","values":["schedule"]}' \
      --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
      --queries '{"method":"limit","values":[100]}' \
      --queries "{\"method\":\"offset\",\"values\":[$offset]}" \
      | jq -c '(.executions // [])[]' ) >> "$IDRUNS" || { echo "FETCH FAILED at offset $offset"; break; }
done
jq -rs --arg from "$FROM" --arg to "$TO" '
  def at: .["$createdAt"][0:19] + "Z";
  [unique_by(.["$id"])[] | select(at >= $from and at < $to)] as $runs
  | [$runs[] | ((.errors // "") + "\n" + (.logs // "")) | split("\n")[] | fromjson? | objects
      | select(.event | IN("merge_carries_on", "merge_run_failed"))]
  | group_by([.event, .personId // "-", .intoPersonId // "-"])
  | "identity runs \($runs | length) · merges carried on \(map(select(.[0].event == "merge_carries_on")) | length) · merge runs failed \(map(select(.[0].event == "merge_run_failed")) | length)",
    (.[] | "\(.[0].event) \(.[0].personId // "-") into \(.[0].intoPersonId // "-") · \(length) of \($runs | length) runs · \(.[0].cause // "-")")
' "$IDRUNS"
rm "$IDRUNS"
```

Each line is the event, the merged person's ID and the one it goes into, in how many runs of the window it appeared, and the error's name for a failed run.

- **D doesn't fail the read:** a merge can wait a while for a group that's busy, or for someone's leave to finish.
- **Post on #96** a merge that's carried on at two reads in a row (it's stuck), and any `merge_run_failed`, with its IDs and `cause`.

## The result

Post one comment per read on #299, in this form:

```text
2026-10-21T02:38:27Z → 2026-10-22T02:20:00Z · runs 24, not ok 0, longest gap 60 min, longest run 165 s · logged 24 of 24 · findings 0 · failed 0 · cut off 0 · removed 0 · overdue 0 · pending none · merges carried on 0 · PASS
```

- **PASS** needs A, B and C to pass. D's count is posted, but doesn't fail the read. Anything else is FAIL, with the IDs on #96. A read that's too early (A) isn't posted.
- **`pending`** lists the pending groups' IDs, so the next read can tell.
- **Then read every function's error lines** in the same shell, with the same `FROM` and `TO` ([error lines](error-lines.md)). Post its line in the same comment, under this one. It never changes this count.
- **The 2 weeks are done** when passing reads cover 14 days without a break: each read starts at the `to` of the one before, and none failed. **A failed read starts the count again** from its `to`.
- AI A keeps the count in #299's section 1 at each sweep.

**At the end:** the owner deletes the key, and the lead ticks the criterion in #299.

## Not covered

- **A group that's `busy` at every run.** It's put off an hour each time, with no line, so C never sees it overdue. It would take a write to its shares during every check, so it's accepted.
- **A finding in a run whose logs are gone.** That's why each read has to come within 23 hours, and B counts the runs that still have their lines.
