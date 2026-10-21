# First deploy

The lead's runbook for the first deploy after the Actions outage ([#478](https://github.com/rojinc/ledgerly/issues/478), from [#299](https://github.com/rojinc/ledgerly/issues/299) section 5). Run it top to bottom. **Every step only reads, except the two backfills in step 3b**, which already exist and are the lead's to run. Agents never run any of it (AGENTS.md).

| Step | When | What it proves |
| --- | --- | --- |
| [1a](#1a-the-users-queries-the-account-job-uses) | before the deploy | `users.list` takes the account job's label and `$id` queries |
| [1b](#1b-what-resend-answers) | before the deploy | what every send will meet: a 403 until the domain is verified |
| [2](#2-the-deploy) | the deploy | the run is green and pushed everything |
| [3a](#3a-the-new-columns-tables-and-indexes) | right after | every new column, table and index is `available` |
| [3b](#3b-the-backfills-305-and-342) | a minute after | the receipt-files and `orphanedAt` backfills ran |
| [3c](#3c-the-session-check-279) | right after | the account routes read the caller's session |
| [4a](#4a-the-hourly-runs) | after 1–2 hours | each hourly function runs on its own |
| [4b](#4b-a-blocked-send-logs-once-469) | after 1–2 hours | a 401 or 403 logs once per step and changes nothing |
| [4c](#4c-step-3bs-checkpoint) | after 1–2 hours | step 3b made and moved its checkpoint |
| [5](#5-clean-up) | at the end | the one-off keys are gone |

## Before you start

- **Tools:** `appwrite-cli@28.7.0` (the deploy's pin), `jq`, Node from `.nvmrc`, and a checkout of `main` after `npm ci`.
- **A one-off checks key** (Appwrite → Overview → Integrations → API keys) with only `tables.read`, `rows.read`, `users.read` and `execution.read`. Step 5 deletes it.
- **Point the CLI at dev** without the key reaching your shell history:

  ```bash
  read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
  appwrite client --endpoint https://syd.cloud.appwrite.io/v1 --project-id ledgerly-dev --key "$APPWRITE_API_KEY"
  unset APPWRITE_API_KEY
  ```

- **Print IDs, never addresses or names.** The commands below pipe through `jq` for that. Post results on #96 as counts, IDs and pass or fail.

## 1. Before the deploy

Neither check needs the new code, so a failure here costs no deploy.

### 1a. The users queries the account job uses

The account function's hourly job lists users by label, `e2e` ([#386](https://github.com/rojinc/ledgerly/issues/386), [#453](https://github.com/rojinc/ledgerly/pull/453)) and `deleted`, in pages ordered and continued by `$id` (`labelledUsers()` in `functions/account/src/routes/hourly-job.ts`). Only fakes have run those queries. If the server refuses one, every hourly run of the job fails.

```bash
for label in e2e deleted; do
  for after in none 0; do
    page=()
    [ "$after" = none ] || page=(--queries "{\"method\":\"greaterThan\",\"attribute\":\"\$id\",\"values\":[\"$after\"]}")
    appwrite users list --json \
      --queries "{\"method\":\"contains\",\"attribute\":\"labels\",\"values\":[\"$label\"]}" \
      "${page[@]}" \
      --queries '{"method":"orderAsc","attribute":"$id"}' \
      --queries '{"method":"limit","values":[100]}' \
      | jq -r --arg l "$label" --arg a "$after" '"\($l) after \($a): \((.users // []) | length) users, IDs \([(.users // [])[]["$id"]])"'
  done
done
```

- **Pass:** four lines and no error. Each count is 0, unless an e2e run or an account deletion happened before the outage. The account job deletes those users after the deploy.
- **If it fails** (an error such as an invalid query): don't deploy. Post the error on #96; the job's query needs changing first (AI A, who wrote the job).

### 1b. What Resend answers

The owner, or whoever holds the Resend key, sends one test email the way `sendEmail()` does, from `EMAIL_FROM` (Appwrite → Settings → Variables), to Resend's test inbox. It touches nothing in Appwrite.

```bash
read -rs RESEND_API_KEY && export RESEND_API_KEY
curl -sS -w '\nHTTP %{http_code}\n' https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" -H 'content-type: application/json' \
  -d '{"from":"<EMAIL_FROM exactly>","to":"delivered@resend.dev","subject":"Ledgerly first-deploy check","text":"Test."}'
unset RESEND_API_KEY
```

| Answer | Means | Then |
| --- | --- | --- |
| `HTTP 403`, `"name":"validation_error"`, "domain is not verified" or "You can only send testing emails" | the domain isn't set up yet (#3) | expected. Deploy: since #475 each step logs one blocked send per run and changes nothing (step 4b). |
| `HTTP 200` with an `id` | the domain is verified; the email went to Resend's test inbox | emails go out from the first run. Step 4b has nothing to check. |
| `HTTP 401`, or `HTTP 400` with "API key is invalid" | the key is wrong | the owner fixes `RESEND_API_KEY` on #3. Deploying anyway is safe (#475): nothing is sent or lost until it's fixed. |
| anything else | | post the status and `name` on #96 before deploying |

## 2. The deploy

The Deploy workflow runs on the next merge to `main` once Actions has minutes, or when the lead presses **Run workflow** on `main` ([environments and deploys](environments-and-deploys.md#cicd-github-actions)). Never re-run an old Deploy run.

- **Pass:** the run is green. The table plan and the table check pass, every push step succeeds, and "Choose what to deploy" gives new code to every function and the site, since everything changed during the outage. That's also #313's check: its notice names them all.
- **Note the time** the run finished, in UTC: `DEPLOYED_AT`, such as `2026-11-01T09:30:00Z`.
- **If the plan or the table check stops it:** nothing destructive was applied. Follow [when the plan stops a deploy](environments-and-deploys.md#schema-changes-that-lose-data).
- **If a push step fails:** the run says which. Fix the cause, then **Run workflow** on `main`.

## 3. Right after the deploy

### 3a. The new columns, tables and indexes

The push creates them. This checks the server finished each one (`status` `available`, not `processing` or `failed`).

```bash
cols() { appwrite tablesdb list-columns --database-id main --table-id "$1" --limit 100 --json | jq -r '(.columns // [])[] | "\(.key) \(.status)"'; }
idxs() { appwrite tablesdb list-indexes --database-id main --table-id "$1" --limit 100 --json | jq -r '(.indexes // [])[] | "\(.key) \(.status)"'; }
for t in persons profiles groups schedules statements activity changeNotices; do echo "== $t"; cols "$t"; idxs "$t"; done
```

**Pass:** no line ends in anything but `available`, and these are all listed ([data model](../architecture/data-model.md)):

| Table | Columns | Indexes | From |
| --- | --- | --- | --- |
| `persons` | `addressMisses`, `addressMissesFrom`, `orphanedAt`, `mergeResumeAt` | `idx_orphanedAt` | #274, #342, #458 |
| `profiles` | `emailOptOuts` | | #443 |
| `groups` | `deletingAt`, `deletingBy` | `idx_deletingAt` | #446 |
| `schedules` | `pausedFrom` | | #437 |
| `statements` | `autoSendUntil` | `idx_autoSendUntil` | #442 |
| `activity` | | `idx_action_at` | #445 |
| `changeNotices` (a new table) | `userId`, `kind`, `identityId`, `idempotencyKey`, `attempts` | `uniq_idempotencyKey`, `idx_userId` | #462 |

**If it fails:**
- **`processing`:** wait a minute and run it again.
- **`failed`:** see why with `appwrite tablesdb list-columns --database-id main --table-id <table> --json | jq '.columns[] | select(.status != "available") | {key, status, error}'` (or `list-indexes` and `.indexes[]`). The lead fixes the server with the Appwrite MCP, then runs **Run workflow** on `main`, as [environments and deploys](environments-and-deploys.md#schema-changes-that-lose-data) says for a server that's wrong.
- **Missing:** the table push didn't apply it. Read the Deploy run's table push output, then as for `failed`.

### 3b. The backfills (#305 and #342)

Wait at least a minute after the deploy, so no execution of the old code is still running (each script's header says why). Both print counts only, and both are safe to run again.

1. **Has #305's backfill run before?** (checks key)

   ```bash
   appwrite tablesdb get-row --database-id main --table-id checkpoints --row-id receipt-clean-up --json | jq -r .through
   ```

   A date means it has: skip it, or run it again, which is safe. "Row not found" means it hasn't: run it.
2. **Make a second one-off key** with only `rows.read`, `rows.write` and `files.read`. The checks key can't write.
3. **Run both**, from the root of `main` after `npm ci`:

   ```bash
   read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
   export APPWRITE_ENDPOINT=https://syd.cloud.appwrite.io/v1 APPWRITE_PROJECT_ID=ledgerly-dev
   node scripts/backfill-receipt-files.mjs
   node scripts/backfill-orphaned-at.mjs
   unset APPWRITE_API_KEY
   ```

- **Pass:**
  - `backfill-receipt-files.mjs` prints `{ updated, unchanged, deleting: 0, swept }` and exits 0. Step 1's command then prints a date: scheduler step 5 starts receipt clean-up from its next run.
  - `backfill-orphaned-at.mjs` prints `{ marked, unchanged }` and exits 0. Each marked placeholder is cleared by step 5c 30 days later.
- **If it fails:**
  - **"N receiptFiles rows are being deleted but listed. Check them."** (exit 1): step 5 is deleting files that transactions still list. Don't run it again. Post the count on #96 for AI D, who wrote the backfill.
  - **It throws** (a row kept changing through 3 tries): run it again. If it throws again, post the error's name on #96.

### 3c. The session check (#279)

`POST /delete` and `POST /groups/{id}/delete` refuse a session older than 10 minutes. They find the session from the `sessionId` in the caller's JWT (`sessionIdOf()` in `packages/server/src/http/create-handler.ts`). If the JWT Appwrite gives a function has no `sessionId`, both refuse everyone with `reauth`. Nothing else breaks.

This asks the account function to delete **your own personal group**. That can't delete anything: the route checks the session, then always refuses a personal group (`refuseGroup()` in `functions/account/src/routes/delete-group.ts`), and it writes nothing before either.

1. **Your personal group's ID** (checks key). Your user ID is in Appwrite → Auth → Users.

   ```bash
   person=$(appwrite tablesdb list-rows --database-id main --table-id persons --json \
     --queries '{"method":"equal","attribute":"userId","values":["<your user ID>"]}' | jq -r '.rows[0]["$id"]')
   appwrite tablesdb list-rows --database-id main --table-id groups --json \
     --queries "{\"method\":\"equal\",\"attribute\":\"ownerPersonId\",\"values\":[\"$person\"]}" \
     --queries '{"method":"equal","attribute":"type","values":["personal"]}' | jq -r '.rows[0]["$id"]'
   ```

2. **Sign out of the app** (`https://ledgerly.appwrite.network`) **and sign in again**, so your session is less than 10 minutes old.
3. **Within 10 minutes,** in that tab's developer console, call the route as the app does, with your session:

   ```js
   const fallback = localStorage.getItem('cookieFallback')
   const res = await fetch('https://syd.cloud.appwrite.io/v1/functions/account/executions', {
     method: 'POST',
     credentials: 'include',
     headers: {
       'content-type': 'application/json',
       'x-appwrite-project': 'ledgerly-dev',
       ...(fallback ? { 'x-fallback-cookies': fallback } : {}),
     },
     body: JSON.stringify({
       path: '/groups/<your personal group ID>/delete',
       method: 'POST',
       async: false,
       body: JSON.stringify({ confirm: 'DELETE' }),
     }),
   })
   const execution = await res.json()
   // The route's answer, or Appwrite's own error when the call didn't reach the function.
   console.log(execution.responseBody ? JSON.parse(execution.responseBody) : execution)
   ```

| Answer | Means |
| --- | --- |
| `VALIDATION_FAILED`, "Your personal group can’t be deleted." | **pass:** the session was found and is recent |
| `FORBIDDEN` with `details.reason` `recent_password_change` | **pass:** the session was found; your password changed in the last day |
| `FORBIDDEN` with `details.reason` `reauth` | **fail:** the JWT has no `sessionId`, or the session isn't listed. Post on #96 (AI A wrote the check). |
| `NOT_FOUND`, or `FORBIDDEN` with no `reason` | the wrong group ID, or you aren't its admin: check step 1 |
| Appwrite's own error (`type` such as `user_unauthorized`), with no `ok` | the call didn't carry your session: run it in the app's tab, signed in |

## 4. After the first hourly runs

Appwrite starts each hourly function at a minute it picks, within the hour of the deploy ([intervals, not cron](environments-and-deploys.md#function-settings)). Give it 70 minutes for the first runs, and two hours to see a second.

### 4a. The hourly runs

`identity`, `account`, `scheduler` and `statements` each run every 60 minutes (`interval: 60`).

```bash
for fn in identity account scheduler statements; do
  appwrite functions list-executions --function-id "$fn" --json \
    --queries '{"method":"equal","attribute":"trigger","values":["schedule"]}' \
    --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
    --queries '{"method":"limit","values":[3]}' \
    | jq -r --arg f "$fn" '(.executions // [])[] | "\($f) \(.["$createdAt"]) \(.status) \(.responseStatusCode)"'
done
```

- **Pass:** each function has a `schedule` run after `DEPLOYED_AT` with `completed` and `200`, and after two hours a second one about 60 minutes later. `account`'s `200` also shows its users queries (step 1a) work on the server.
- **If it fails:**
  - **No run after 70 minutes:** the interval didn't take. Check the Deploy run's function push for "doesn't support cron schedules" or a skipped function, and [function settings](environments-and-deploys.md#function-settings).
  - **`failed` or a 500:** read the run's event names (the next command shows them for a 401 or 403) and post them on #96 with the function and the execution ID.

### 4b. A blocked send logs once (#469)

Only while step 1b answered 403 (or 401). Each step stops at its first blocked email, logs one line, and changes nothing: no reminder marked, no summary moved on, no change notice deleted, no auto-send window closed ([conventions](conventions.md#functions)).

```bash
for fn in scheduler statements identity; do
  appwrite functions list-executions --function-id "$fn" --json \
    --queries '{"method":"equal","attribute":"trigger","values":["schedule"]}' \
    --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
    --queries '{"method":"limit","values":[1]}' \
    | jq -r --arg f "$fn" '(.executions // [])[] | (.errors // "") | split("\n")[] | fromjson? | select((.cause // "") | startswith("EmailError")) | "\($f) \(.event) \(.cause)"' \
    | sort | uniq -c
done
```

- **Pass:** in the latest run of each, **at most one** line for each of these, with the cause `EmailError validation_error 403` (or `401`):
  - `scheduler`: `reminder_failed`, `summary_failed`, `transaction_changes_failed`;
  - `statements`: `auto_send_failed`;
  - `identity`: `change_notice`.

  `statements`' `ready_email_failed` can still appear once per admin until #476 merges. No line at all is also a pass: nothing was due to send.
- **If it fails:** a count above 1 for one of those events, with a 401 or 403 cause, means that step didn't stop. Post the function, event and count on #96 (AI A wrote #475). A cause of `EmailError validation_error 400` or `422` is an address Resend refused, which is expected now and then.

### 4c. Step 3b's checkpoint

Step 3b (#445, #461) makes the `transaction-changes` checkpoint at the start of the hour of its first run, then moves it an hour at a time.

```bash
appwrite tablesdb get-row --database-id main --table-id checkpoints --row-id transaction-changes --json | jq -r .through
```

- **Pass:** a date on the hour, at most an hour or two before now, and later on the next check.
- **If it fails:** "Row not found" after the scheduler's first run means step 3b didn't run. Look for `transaction_changes_failed` or `transaction_changes_skipped` in that run (4b's command, without the `EmailError` filter), and post them on #96.

## 5. Clean up

- **Delete both one-off keys** in Appwrite → Overview → Integrations → API keys. The CLI keeps the checks key in its own settings, so deleting it on the server is what matters.
- **Tick the items** in #299 section 5, and post the results on #96: pass or fail for each step, with counts and IDs only.

## Not in this runbook

#299 section 5's other checks are by hand, with a test account in the app, or in the console: the password events (#289), the auth settings (#316), placeholders with two identities (#304), the bundle sizes (#270), the invite flows (#371, #403 item 5), history across groups (#424) and a wrong address counted once (#274). They stay on #299.
