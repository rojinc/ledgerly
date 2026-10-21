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

**With the script** ([`scripts/reads.mjs`](../../scripts/reads.mjs), [#553](https://github.com/rojinc/ledgerly/issues/553)): it runs A, B and C below, and then the [error lines](error-lines.md) read, as this page's blocks define them. It prints the two lines to post on #299, then any lines to post on #96.

```bash
read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY   # typed, so it stays out of the shell history
APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… node scripts/reads.mjs --from <the last result's to> --fetch
unset APPWRITE_API_KEY
```

- **`--fetch`** makes the same read-only queries as the blocks below, with the read key, and never prints the key. If the server refuses the order, add `--order-by-id`, as the blocks' own fallback does. Or fetch with the blocks, and pass the files instead, taking them before the blocks' `rm "$RUNS"`, with **`--to "$TO"`**, the blocks' own `TO`, so the read ends where the files do. The script refuses files without `--to`:
  - `--runs`: both fetches' `$RUNS` files, this page's and [error lines](error-lines.md#a-read)', joined;
  - `--groups`: C's rows, as JSON lines (`| jq -c '(.rows // [])[]'`);
  - `--capped '<functions>'`, if the error-lines fetch printed `CAPPED`. The script names each one in the lines for #96.
  - Copy this page's `$RUNS` before the error-lines fetch, whose `RUNS=$(mktemp)` replaces it. If a fetch printed `FETCH FAILED`, fetch again: the file is short, and the script can't tell.
- **The window:** `--from` is the last result's `to`. With `--fetch`, `--to` is 20 minutes ago unless it's given; with files, it's the blocks' `TO`. `--pending '<IDs>'` takes the last result's pending groups, for C.
- **It exits:**
  - 0 when this read passes and the error lines are `OK`;
  - 1 when there's something to post on #96, even on a PASS and `OK` (a removed membership, or a merge carried on, which is posted at the second read in a row);
  - 2 when there's nothing to post yet: a run hasn't finished (`TOO EARLY`); a fetch failed or its reply wasn't the JSON expected (`FETCH FAILED`, with the status and the error's type); or it can't read an argument or a file (the usage, with the error's code). Anything else stops it with `STOPPED` and the error's name. It never prints a reply's body, a file's text or a stack.
- **The blocks below are the fallback.** `scripts/reads.test.mjs` runs them and the script on the same made-up runs, and checks they print the same lines.

**By hand:** set the window. `FROM` is the `to` of the last result posted on #299. The first read starts at Deploy run 174's `DEPLOYED_AT`, and **the lead runs it on 2026-10-21 at about 08:00Z**: it confirms those first hours, and its `logged N of N` shows at once whether the logs last that long. The next read comes within 23 hours of its `to`. `TO` is 20 minutes ago, so every run in the window has finished: a run can take up to 15 minutes.

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

## The result

Post one comment per read on #299, in this form:

```text
2026-10-21T02:38:27Z → 2026-10-22T02:20:00Z · runs 24, not ok 0, longest gap 60 min, longest run 165 s · logged 24 of 24 · findings 0 · failed 0 · cut off 0 · removed 0 · overdue 0 · pending none · PASS
```

- **PASS** needs A, B and C to pass. Anything else is FAIL, with the IDs on #96. A read that's too early (A) isn't posted.
- **`pending`** lists the pending groups' IDs, so the next read can tell.
- **Then read every function's error lines** in the same shell, with the same `FROM` and `TO` ([error lines](error-lines.md)). Post its line in the same comment, under this one. It also lists merges that don't finish. It never changes this count.
- **The 2 weeks are done** when passing reads cover 14 days without a break: each read starts at the `to` of the one before, and none failed. **A failed read starts the count again** from its `to`.
- AI A keeps the count in #299's section 1 at each sweep.

**At the end:** the owner deletes the key, and the lead ticks the criterion in #299. From then on, [the reads job](#after-the-two-weeks) reads every 8 hours.

## After the two weeks

**The reads job** ([`.github/workflows/reads.yml`](../../.github/workflows/reads.yml), [#568](https://github.com/rojinc/ledgerly/issues/568)) keeps reading A and B, and the [error lines](error-lines.md), with the script, so a failure still reaches someone after the lead's reads stop. **Nobody runs it by hand:** it runs every 8 hours, at 00:17, 08:17 and 16:17 UTC, and **Run workflow** is for the owner's first run only.

- **Its key** has `execution.read` only, and is kept in the `reads` environment, which only `main` can use ([secrets](../architecture/security-and-privacy.md#secrets-inventory)). It reads no table, so the job leaves out C: its line says `overdue not read`, and its PASS is A's and B's.
- **What it calls:** `GET /functions/{id}/executions` for each of the script's six functions, with `execution.read`, and nothing else in Appwrite. The function IDs are the script's own list, never read from Appwrite: listing functions needs `functions.read`, which can return their variables, so the key never gets it. On GitHub, it reads, comments on and edits one issue, with the run's own token (`issues: write`).
- **Its state is one line in the body of [#581](https://github.com/rojinc/ledgerly/issues/581),** the pinned reads issue, which only collaborators can edit: `Last read: to <time> · nightly <verdict> · errors <verdict> · at <time>`. Each read starts at that `to` and ends 20 minutes ago, and the job rewrites the line after a read that ran. A comment is never read.
  - **A `to` over 23 hours old,** or a line that isn't one the job wrote, starts the read 23 hours ago, the oldest the logs reach, and the comment says which hours weren't read.
  - **The issue's title** is checked before every write, so the job never acts on another issue.
  - **Edit the body between runs:** a run writes back the body it read at its start, so an edit made in the seconds it runs is lost.
- **It posts on #581** when a read exits 1, when it couldn't read (`FETCH FAILED`, `STOPPED`), when a run is still waiting at two reads running (`TOO EARLY`), or when it couldn't start from the last read. The comment holds the script's lines, without the `Post on` headers. The run then fails too, so GitHub's own notice goes to the account that last changed the `cron` line.
- **The state moves only after a read that ran,** and after its comment. So a read that couldn't fetch, or a comment GitHub refused, is read again next time.
- **The lead triages each comment** by the [error lines' verdict](error-lines.md#the-verdict), and replies with what was done: a `bug` issue for STUCK, a closer look for LOOK, a shorter interval for INCOMPLETE or a capped function, and the key for `FETCH FAILED`. Nothing resets, since there's no count after M4, and a problem that lasts is posted at every read until its fix is deployed.
- **If it stops:** GitHub turns off a public repo's scheduled workflows after 60 days without commits. #581's line shows it, since its `to` stops moving, and the owner turns the workflow back on (Actions → Reads → Enable workflow).

## Not covered

- **A group that's `busy` at every run.** It's put off an hour each time, with no line, so C never sees it overdue. It would take a write to its shares during every check, so it's accepted.
- **A finding in a run whose logs are gone.** That's why each read has to come within 23 hours, and B counts the runs that still have their lines.
