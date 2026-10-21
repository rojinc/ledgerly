# Error lines

Every function's error lines, read with the [nightly check](nightly-check.md) at each of its reads ([#524](https://github.com/rojinc/ledgerly/issues/524)). **Until alerting exists, the error lines are the alert** ([conventions](conventions.md#functions)), and the nightly check reads only its own. This read catches a failure that repeats every hour, such as an account deletion that never finishes, a draft that fails for one group, or a `balances` row that doesn't fit its shares.

**It's the alert, not a gate.** Its result never changes the nightly check's count, which is M4's criterion alone.

**Who runs it:** the lead, right after the nightly-check read, in the same shell, with the same `FROM`, `TO` and key. `execution.read` covers every function's runs. **No other agent** runs any of it (AGENTS.md). **Nothing here writes.**

## What the functions write

Each run writes:
- **one request line:** `{ fn, route, status, ms, code?, cause? }`, written to `errors` when `status` is 500 or more, otherwise to `logs`. `route` is the route's pattern, such as `POST /statements/:id/finalize`, so it never carries an ID.
- **event lines** from `logProblem`, each with `fn` and `event` ([conventions](conventions.md#functions)).

An event is an error unless `LEVELS` in `packages/server/src/http/log.ts` makes it a `log` or a `warn`. A password or change notice is an error only when its `outcome` is `failed`.

**The 24 error events this read covers,** plus the two notices:

| Function | Runs | Error events |
| --- | --- | --- |
| `scheduler` | every 60 min | `reminder_failed`, `auto_post_failed`, `summary_failed`, `receipt_cleanup_failed`, `receipt_row_listed`, `invite_cleanup_failed`, `placeholder_cleanup_failed`, `transaction_changes_failed` |
| `statements` | every 60 min, and requests | `draft_failed`, `ready_email_failed`, `auto_finalize_failed`, `auto_send_failed`, `auto_send_notice_failed`, `snapshot_check_failed` |
| `account` | every 60 min, and requests | `account_finish_failed`, `e2e_user_not_deleted`, `stuck_finalize_archived`, `schedule_template_unreadable` |
| `identity` | every 60 min, four user events, and requests | `merge_run_failed`, `merge_no_member_dates`, `merge_member_dates_unreadable`, `person_reminder_failed`; `password_notice` and `change_notice` when `failed` |
| `ledger` | requests | `balances_row_unusable`; `balances_row_deleted`, wherever shares are written |
| `groups` | requests | none: only its 500s |

The nightly check's B reads its three error events: `nightly_check_finding`, `nightly_check_failed` and `team_membership_removed`. This read skips them, so they aren't counted twice.

**The read skips a list of events, not includes one.** So an event added to `LogEvent` later counts as an error here, as it does in `log.ts`, until it's given a level. The list below mirrors `LEVELS` as of `e8fbfec`; when `LEVELS` changes, change it too.

**A send blocked by the unverified domain** ([#3](https://github.com/rojinc/ledgerly/issues/3)) comes with a `cause` of `EmailError <type> 401` or `403`, or `EmailError invalid_api_key`. It's kept for the next run (`refusedForGood` in `packages/server/src/email/send-email.ts`), so it repeats every hour until #3 is done. Until then, it's counted on its own as `email blocked`, and isn't an error line.

## A read

Run it after the nightly-check read, in the same shell, so `FROM` and `TO` are already set.

Fetch every function's runs, of every trigger, newest first, 100 at a time, until a page reaches back past `FROM`. The page that does also holds the run before the window, which the gaps are measured from.

```bash
RUNS=$(mktemp); CAPPED=; FAILED=
for fn in scheduler statements account identity groups ledger; do
  offset=0
  while :; do
    PAGE=$(set -o pipefail
      appwrite functions list-executions --function-id "$fn" --json \
        --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
        --queries '{"method":"limit","values":[100]}' \
        --queries "{\"method\":\"offset\",\"values\":[$offset]}" \
        | jq -c --arg fn "$fn" '(.executions // [])[] | . + {fn: $fn}') \
      || { FAILED=$fn; echo "FETCH FAILED $fn at offset $offset"; break 2; }
    [ -n "$PAGE" ] && printf '%s\n' "$PAGE" >> "$RUNS"
    printf '%s\n' "$PAGE" | jq -se --arg from "$FROM" \
      'length < 100 or (.[-1]["$createdAt"][0:19] + "Z" < $from)' > /dev/null && break
    offset=$((offset + 100))
    [ "$offset" -ge 2000 ] && { CAPPED="$CAPPED $fn"; echo "CAPPED $fn"; break; }
  done
done
```

- **`FETCH FAILED`:** stop, delete the runs (`rm -f "$RUNS"`), and post the CLI's error on #96. A read without every page can't be confirmed.
- **`CAPPED`:** that function had more than 2,000 runs since `FROM`, and the read stopped there. The read is `INCOMPLETE`. Read sooner, and post the count on #96.

Then read them. It prints the result line, then one line per run that isn't ok, and one per group of error lines.

```bash
jq -rs --arg from "$FROM" --arg to "$TO" --arg capped "$CAPPED" --arg failed "$FAILED" '
  def at: .["$createdAt"][0:19] + "Z";
  def lines: ((.errors // "") + "\n" + (.logs // "")) | split("\n") | map(fromjson? | objects);
  # LEVELS in log.ts (log and warn), and the nightly check B events.
  def skipped: IN(
    "typed_keys_deleted", "merge_typed_keys_deleted", "merge_finished", "merge_carries_on",
    "merge_stopped_into_deleted", "merge_run", "claim_identity_unusable", "nightly_check_cut_off",
    "pdf_characters_replaced", "merge_left_transaction", "merge_left_locked_transaction",
    "merge_left_schedule", "merge_left_stray_row", "merge_left_subjects", "merge_put_off_team_gone",
    "merge_left_inputs", "merge_stopped", "merge_walk_cut_off", "receipt_cleanup_behind",
    "receipt_cleanup_tied", "transaction_changes_skipped",
    "nightly_check_finding", "nightly_check_failed", "team_membership_removed");
  def error:
    if has("route") then (.status // 0) >= 500
    elif .event == "password_notice" or .event == "change_notice" then .outcome == "failed"
    elif has("event") then (.event | skipped | not)
    else false end;
  def blocked: (.cause // "") | test("^EmailError ([a-z_]+ (401|403)|invalid_api_key)");
  def ids: . as $l | ["groupId", "statementId", "transactionId", "personId", "intoPersonId", "userId",
    "profileId", "scheduleId", "reminderId", "membershipId", "rowId"]
    | map(select($l[.]) | "\(.) \($l[.])") | join(" ");
  def notok: .status != "completed" or (.responseStatusCode // 0) >= 500;
  def gap($fn): map(select(.fn == $fn and .trigger == "schedule")) as $s
    | ([$s[] | select(at < $from) | at] | max // $from) as $before
    | [$before] + ([$s[] | select(at >= $from and at < $to) | at] | sort) + [$to]
    | map(fromdateiso8601) | [range(1; length) as $i | .[$i] - .[$i - 1]] | max / 60 | floor;
  unique_by(.["$id"]) as $all
  | ["scheduler", "statements", "account", "identity", "groups", "ledger"] as $fns
  | ($fns[:4] | map(. as $fn | {fn: $fn, gap: ($all | gap($fn))})) as $gaps
  | [$all[] | select(at >= $from and at < $to)] as $runs
  | [$runs[] | select(.status == "completed")] as $done
  | [$runs[] | . as $run | lines[] | select(error) | . + {run: $run["$id"], at: ($run | at)}] as $lines
  | ($lines | map(select(blocked | not)) | group_by([.fn, .event // .route, .cause // "-", ids])) as $groups
  | ($groups | map(select(map(.run) | unique | length >= 3))) as $repeating
  | ($runs | map(select(notok))) as $notok
  | ($gaps | max_by(.gap)) as $worst
  | ([$done[] | select(lines | any(has("route")))] | length) as $logged
  | (if $failed != "" then "FETCH FAILED"
     elif any($runs[]; .status == "waiting" or .status == "processing") then "TOO EARLY"
     elif $capped != "" or $logged < ($done | length) then "INCOMPLETE"
     elif ($repeating | length) > 0 or $worst.gap > 125 then "STUCK"
     elif ($groups | length) > 0 or ($notok | length) > 0 then "LOOK"
     else "OK" end) as $verdict
  | "errors \($from) → \($to) · runs \($fns | map(. as $fn | "\($fn) \([$runs[] | select(.fn == $fn)] | length)") | join(", ")) · not ok \($notok | length) · longest gap \($worst.gap) min (\($worst.fn)) · logged \($logged) of \($done | length) · error lines \($groups | map(length) | add // 0) in \($groups | length) groups · repeating \($repeating | length) · email blocked \($lines | map(select(blocked)) | length) · \($verdict)",
    ($notok[] | "not ok \(.fn) \(.["$id"]) \(at) \(.trigger) \(.status) \(.responseStatusCode // "-")"),
    ($groups[] | .[0] as $l | [
      (map(.run) | unique | length | if . == 1 then "1 run" else "\(.) runs" end),
      "\($l.fn) \($l.event // $l.route)",
      (if $l | has("route") then "\($l.status) \($l.code // "-")" else empty end),
      ($l.cause // empty | "cause \(.)"),
      ($l.outcome // empty | "outcome \(.)"),
      ($l | ids | select(. != "")),
      "first \(map(.at) | min) last \(map(.at) | max)"
    ] | join(" · "))
' "$RUNS"
rm "$RUNS"
```

Every line prints only fixed fields: the function, the run's ID and time, the trigger, the event or route, the status, the error code, the error's name (`cause`), a notice's `outcome`, and each row ID with its field's name, such as `personId 6714…`. Never a raw line, a stack, the request's path or a response body.

## The verdict

| Verdict | When | What to do |
| --- | --- | --- |
| **OK** | every finished run has its lines, no run is `not ok`, every gap is 125 minutes or less, and there are no error lines besides blocked sends | post the result line |
| **LOOK** | an error line, a 500 or a run that isn't ok, that doesn't repeat | post the result line, and the group's or run's line on #96. The lead decides whether it needs an issue |
| **STUCK** | a group of error lines in **3 or more runs**, or a scheduled function with a gap over 125 minutes | post the lines on #96, and file a `bug` issue with the IDs |
| **INCOMPLETE** | a finished run whose lines are gone (`logged` fewer than the finished runs), or `CAPPED` | the window can't be confirmed. Post the counts on #96, and read sooner next time |
| **TOO EARLY** | a run is still `waiting` or `processing` | run the read again later, with the same `FROM`. It isn't posted |
| **FETCH FAILED** | a page of runs couldn't be fetched | as above: stop, and post the CLI's error on #96. It isn't posted on #299 |

- **A run that isn't ok** is one that `failed`, or answered 500 or more. A request's 4xx, such as `FORBIDDEN`, is someone being refused, and is fine.
- **A failed run may have no lines:** Appwrite stops a run at its timeout before it can log. It's in `not ok`, not in `logged`.
- **A repeating group** is the same function, event or route, error name and IDs in 3 or more runs: three hourly tries that all failed. A one-off failure that the next run fixes shows up once or twice.
- **The groups of the scheduled steps** are each tried every run, so one that keeps failing repeats. Its first and last times show how long it's been failing, within this window.

## The result

Post the result line in the same comment on #299 as the nightly check's result, under it:

```text
errors 2026-10-21T02:38:27Z → 2026-10-22T02:20:00Z · runs scheduler 24, statements 24, account 24, identity 31, groups 5, ledger 140 · not ok 0 · longest gap 60 min (scheduler) · logged 248 of 248 · error lines 0 in 0 groups · repeating 0 · email blocked 72 · OK
```

AI A copies it into #299's section 1 at each sweep, next to the nightly check's line.

## Not covered

- **`warn` lines,** such as a merge that left a row: they're worth a look, not a failure. Read them by hand if one of these lines points to them.
- **A failure whose logs are gone,** which is why the read comes within 23 hours, as the nightly check does, and `logged` counts the runs that still have their lines.
- **The web app's errors:** they stay in the browser, and nothing reports them in v1 (Sentry is cut, [#51](https://github.com/rojinc/ledgerly/issues/51)).
