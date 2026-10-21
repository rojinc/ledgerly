# First deploy

The runbook for the first deploy after the Actions outage ([#478](https://github.com/rojinc/ledgerly/issues/478), from [#299](https://github.com/rojinc/ledgerly/issues/299) section 5). Follow it top to bottom.

**Who runs what:**
- **The owner** makes and deletes the one-off API keys, presses **Run workflow** if a deploy has to be started by hand, holds the Resend key, and does the browser check in 3c. Accounts, secrets, the console and production releases are the owner's ([D-015](../architecture/decisions.md#d-015-the-lead-agent-runs-the-project-day-to-day)).
- **The lead** runs the CLI checks and the two backfills with the keys the owner hands over.
- **No other agent** runs any of it (AGENTS.md).

**What writes:**
- **Rows:** only the two backfills in 3b.
- **Beyond rows:** the owner's two API keys, 1b's test email, and 3c's sign-in and refused request.

| Step | When | Who | What it proves |
| --- | --- | --- | --- |
| [1a](#1a-the-users-queries-the-account-job-uses) | before the deploy | lead | `users.list` takes the account job's label and `$id` queries |
| [1b](#1b-what-resend-answers) | before the deploy | owner | what every send will meet: a 403 until the domain is verified |
| [2](#2-the-deploy) | the deploy | owner, lead | the run is green and pushed everything |
| [3a](#3a-every-column-and-index-is-available) | right after | lead | every column, table and index in `tables.json` is `available` |
| [3b](#3b-the-backfills-305-and-342) | a minute after | lead | the receipt-files and `orphanedAt` backfills ran |
| [3c](#3c-the-session-check-279) | right after | owner | the account routes read the caller's session |
| [4a](#4a-the-hourly-runs) | after 1–2 hours | lead | each hourly function runs on its own |
| [4b](#4b-a-blocked-send-logs-once-469) | after 1–2 hours | lead | a blocked send logs once per step and changes nothing |
| [4c](#4c-step-3bs-checkpoint) | after 1–2 hours | lead | step 3b made its checkpoint |
| [5](#5-clean-up) | at the end | owner, lead | the one-off keys are gone |

## Before you start

- **Tools:** `appwrite-cli@28.7.0` (the deploy's pin), `jq`, Node from `.nvmrc`, and a checkout of `main` after `npm ci`. **Run every command from the checkout's root**: the CLI takes the project from its `appwrite.config.json`.
- **A one-off checks key** (owner: Appwrite → Overview → Integrations → API keys) with only `tables.read`, `rows.read`, `users.read` and `execution.read`. Step 5 deletes it. If a command fails with `missing scopes (["…"])`, the server is naming the scope it accepts there: add that one.
- **Point the CLI at dev** without the key reaching your shell history. Don't pass `--project-id`: the CLI would write it into the repo's `appwrite.config.json`, which already names `ledgerly-dev`.

  ```bash
  read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
  appwrite client --endpoint https://syd.cloud.appwrite.io/v1 --key "$APPWRITE_API_KEY"
  unset APPWRITE_API_KEY
  git status --short appwrite.config.json   # prints nothing: the file is unchanged
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
- **If it fails** (an error such as an invalid query): don't deploy. Post the error on #96. The job's query needs changing first (AI A wrote the job).

### 1b. What Resend answers

The owner sends one test email the way `sendEmail()` does, from `EMAIL_FROM` (Appwrite → Settings → Variables), to Resend's test inbox. It touches nothing in Appwrite.

```bash
read -rs RESEND_API_KEY && export RESEND_API_KEY
curl -sS -w '\nHTTP %{http_code}\n' https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" -H 'content-type: application/json' \
  -d '{"from":"<EMAIL_FROM exactly>","to":"delivered@resend.dev","subject":"Ledgerly first-deploy check","text":"Test."}'
unset RESEND_API_KEY
```

| Answer | Means | Then |
| --- | --- | --- |
| `HTTP 403`, `"name":"validation_error"`: "domain is not verified" or "You can only send testing emails" | the domain isn't set up yet (#3) | expected. Deploy: since #475 each step logs one blocked send per run and changes nothing (step 4b). |
| `HTTP 200` with an `id`, and `EMAIL_FROM` is on **our** domain | the domain is verified. The email went to Resend's test inbox. | emails go out from the first run. Step 4b has nothing to check. |
| `HTTP 200`, but `EMAIL_FROM` is `@resend.dev` | Resend's shared sender, which reaches test inboxes but not real people | as the first row: real recipients will get a 403. Fix `EMAIL_FROM` on #3. |
| `HTTP 401`, or `invalid_api_key` or "API key is invalid" at any status | the key is wrong | the owner fixes `RESEND_API_KEY` on #3. Deploying anyway is safe (#475): nothing is sent or lost until it's fixed. |
| anything else | | post the status and `name` on #96 before deploying |

## 2. The deploy

The Deploy workflow runs on the next merge to `main` once Actions has minutes. If one has to be started by hand, the owner presses **Run workflow** on `main` ([environments and deploys](environments-and-deploys.md#cicd-github-actions)). Never re-run an old Deploy run.

- **Pass:** the run is green. The table plan and the table check pass, every push step succeeds, and "Choose what to deploy" gives new code to every function and the site, since everything changed during the outage. That's also #313's check: its notice names them all.
- **Note the time** the run finished, in UTC: `export DEPLOYED_AT=2026-11-01T09:30:00Z` (yours). Steps 4a and 4b use it.
- **If the plan or the table check stops it:** nothing destructive was applied. Follow [when the plan stops a deploy](environments-and-deploys.md#schema-changes-that-lose-data).
- **If a push step fails:** the run says which. Fix the cause, then **Run workflow** on `main` (the owner).

## 3. Right after the deploy

### 3a. Every column and index is available

The push creates each column and index, and the server builds it (`status` goes from `processing` to `available`, or to `failed`). This compares every table in `appwrite/tables.json` with the server, so it also catches a table left behind from before the outage.

```bash
avail() {
  { appwrite tablesdb list-columns --database-id main --table-id "$1" --limit 100 --json | jq -r '(.columns // [])[] | select(.status == "available") | .key'
    appwrite tablesdb list-indexes --database-id main --table-id "$1" --limit 100 --json | jq -r '(.indexes // [])[] | select(.status == "available") | .key'; } | sort
}
for t in $(jq -r '.[]["$id"]' appwrite/tables.json); do
  want=$(jq -r --arg t "$t" '.[] | select(.["$id"] == $t) | ((.columns // [])[].key, (.indexes // [])[].key)' appwrite/tables.json | sort)
  comm -23 <(echo "$want") <(avail "$t") | sed "s/^/$t: not available: /"
done
```

**Pass:** it prints nothing. The new ones since the last deploy include ([data model](../architecture/data-model.md)):

| Table | Columns | Indexes | From |
| --- | --- | --- | --- |
| `persons` | `addressMisses`, `addressMissesFrom`, `orphanedAt`, `mergeResumeAt` | `idx_orphanedAt` | #274, #342, #458 |
| `profiles` | `emailOptOuts` | | #443 |
| `groups` | `deletingAt`, `deletingBy` | `idx_deletingAt` | #446 |
| `schedules` | `pausedFrom` | | #437 |
| `statements` | `autoSendUntil` | `idx_autoSendUntil` | #442 |
| `activity` | | `idx_action_at` | #445 |
| `changeNotices` (a new table) | `userId`, `kind`, `identityId`, `idempotencyKey`, `attempts` | `uniq_idempotencyKey`, `idx_userId` | #462 |

**If it prints a line:**
- **See its status** with `appwrite tablesdb list-columns --database-id main --table-id <table> --json | jq '.columns[] | select(.status != "available") | {key, status, error}'` (or `list-indexes` and `.indexes[]`).
- **`processing`:** wait a minute and run 3a again.
- **`failed`:** its `error` says why. The lead fixes the server with the Appwrite MCP, then the owner runs **Run workflow** on `main`, as [environments and deploys](environments-and-deploys.md#schema-changes-that-lose-data) says for a server that's wrong.
- **Not listed at all:** the table push didn't apply it. Read the Deploy run's table push output, then as for `failed`.

### 3b. The backfills (#305 and #342)

Wait at least a minute after the deploy, so no execution of the old code is still running (each script's header says why). Both print counts only, and both are safe to run again.

1. **Has #305's backfill run before?** (checks key)

   ```bash
   appwrite tablesdb get-row --database-id main --table-id checkpoints --row-id receipt-clean-up --json | jq -r .through
   ```

   - **A date:** it has run. Skip it, or run it again, which is safe.
   - **`✗ Error: Row with the requested ID could not be found.`** (exit 1): it hasn't. Run it.
   - **Any other error** (a missing scope, a missing table): stop and post it on #96.
2. **The owner makes a second one-off key** with only `rows.read`, `rows.write` and `files.read`. The checks key can't write.
3. **Run both**, from the root of `main` after `npm ci`:

   ```bash
   read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
   export APPWRITE_ENDPOINT=https://syd.cloud.appwrite.io/v1 APPWRITE_PROJECT_ID=ledgerly-dev
   node scripts/backfill-receipt-files.mjs
   node scripts/backfill-orphaned-at.mjs
   unset APPWRITE_API_KEY
   ```

- **Pass:**
  - `backfill-receipt-files.mjs` prints `{ updated, unchanged, deleting: 0, swept }` and exits 0. Step 1's command then prints a date, and scheduler step 5 starts receipt clean-up from its next run.
  - `backfill-orphaned-at.mjs` prints `{ marked, unchanged }` and exits 0. Step 5c clears each marked placeholder 30 days later.
- **If it fails:**
  - **It throws** (a row kept changing through 3 tries): run it again. If it throws again, post the error's name on #96.
  - **"N receiptFiles rows are being deleted but listed. Check them."** (exit 1): step 5 is deleting files that transactions still list. This can't happen on a first run, since step 5 does nothing until the backfill's checkpoint exists. If it does happen, the checkpoint is already written, so step 5 carries on within the hour. Stopping it means deleting `checkpoints/receipt-clean-up` ([data model](../architecture/data-model.md#checkpoints)), which is a write: the lead decides at once, with AI D, who wrote the backfill.

### 3c. The session check (#279)

`POST /delete` and `POST /groups/{id}/delete` refuse a session older than 10 minutes. They find the session from the `sessionId` in the caller's JWT (`sessionIdOf()` in `packages/server/src/http/create-handler.ts`). If the JWT Appwrite gives a function has no `sessionId`, both refuse everyone with `reauth`. Nothing else breaks.

This asks the account function to delete the owner's **personal group**. **For a personal group** nothing can be deleted or written: the route checks the session, then always refuses a personal group (`refuseGroup()` in `functions/account/src/routes/delete-group.ts`), and writes nothing before either. **Any other group ID could be purged** if it's archived and nobody else is in it, so the snippet reads the group first and stops unless it's personal.

1. **The personal group's ID** (lead, checks key). The owner's user ID is in Appwrite → Auth → Users.

   ```bash
   person=$(appwrite tablesdb list-rows --database-id main --table-id persons --json \
     --queries '{"method":"equal","attribute":"userId","values":["<owner user ID>"]}' | jq -r '.rows[0]["$id"]')
   appwrite tablesdb list-rows --database-id main --table-id groups --json \
     --queries "{\"method\":\"equal\",\"attribute\":\"ownerPersonId\",\"values\":[\"$person\"]}" \
     --queries '{"method":"equal","attribute":"type","values":["personal"]}' | jq -r '.rows[0]["$id"]'
   ```

2. **The owner signs out of the app** (`https://ledgerly.appwrite.network`) **and signs in again**, so the session is less than 10 minutes old.
3. **Within 10 minutes,** in that tab's developer console, the owner calls the route as the app does, with that session:

   ```js
   (async () => {
     const groupId = '<the personal group ID>'
     const api = 'https://syd.cloud.appwrite.io/v1'
     const fallback = localStorage.getItem('cookieFallback')
     const headers = {
       'content-type': 'application/json',
       'x-appwrite-project': 'ledgerly-dev',
       ...(fallback ? { 'x-fallback-cookies': fallback } : {}),
     }
     // A read: only a personal group is refused in every case, so stop for anything else.
     const group = await (await fetch(`${api}/tablesdb/main/tables/groups/rows/${groupId}`, { credentials: 'include', headers })).json()
     if (group.type !== 'personal') return console.error('Stopped: not a personal group. Check the ID.', group.type ?? group)
     const res = await fetch(`${api}/functions/account/executions`, {
       method: 'POST',
       credentials: 'include',
       headers,
       body: JSON.stringify({
         path: `/groups/${groupId}/delete`,
         method: 'POST',
         async: false,
         body: JSON.stringify({ confirm: 'DELETE' }),
       }),
     })
     const execution = await res.json()
     // The route's answer, or Appwrite's own error when the call didn't reach the function.
     console.log(execution.responseBody ? JSON.parse(execution.responseBody) : execution)
   })()
   ```

| Answer | Means |
| --- | --- |
| `VALIDATION_FAILED`, "Your personal group can’t be deleted." | **pass:** the session was found and is recent |
| `FORBIDDEN` with `details.reason` `recent_password_change` | **pass:** the session was found; the password changed in the last day |
| `FORBIDDEN` with `details.reason` `reauth` | sign out, sign in and run it again at once. **Fail** only if it repeats: the JWT has no `sessionId`, or the session isn't listed. Post on #96 (AI A wrote the check). |
| `NOT_A_MEMBER` | the ID isn't a group the caller is in: check step 1 |
| `NOT_FOUND` | no route matched: `account` wasn't redeployed (step 2). A bad ID stops at the snippet's own check first. |
| "Stopped: not a personal group" | the wrong ID: nothing was sent. Check step 1. |
| Appwrite's own error (`type` such as `user_unauthorized`), with no `ok` | the call didn't carry the session: run it in the app's tab, signed in |
| anything else (`UNAUTHENTICATED`, `INTERNAL`, `function_not_found`) | post the code and message on #96 |

## 4. After the first hourly runs

Appwrite starts each hourly function at a minute it picks, within the hour of the deploy ([intervals, not cron](environments-and-deploys.md#function-settings)). Give it 70 minutes for the first runs, and two hours to see a second.

### 4a. The hourly runs

`identity`, `account`, `scheduler` and `statements` each run every 60 minutes (`interval: 60`).

```bash
for fn in identity account scheduler statements; do
  appwrite functions list-executions --function-id "$fn" --json \
    --queries '{"method":"equal","attribute":"trigger","values":["schedule"]}' \
    --queries "{\"method\":\"greaterThan\",\"attribute\":\"\$createdAt\",\"values\":[\"$DEPLOYED_AT\"]}" \
    --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
    --queries '{"method":"limit","values":[3]}' \
    | jq -r --arg f "$fn" '(.executions // [])[] | "\($f) \(.["$id"]) \(.["$createdAt"]) \(.status) \(.responseStatusCode)"'
done
```

- **Pass:** each function has a run with `completed` and `200`, and after two hours a second one about 60 minutes later. `account`'s `200` also shows its users queries (1a) work on the server.
- **If it fails:**
  - **An invalid-query error:** the server refuses the `$createdAt` filter. Drop the two `$createdAt` queries, raise the limit to 10, and filter in `jq` instead: `select(.["$createdAt"] > $since)`, with `--arg since "$DEPLOYED_AT"`. 4b's command takes the same change.
  - **No run after 70 minutes:** the interval didn't take. Check the Deploy run's function push for "doesn't support cron schedules" or a skipped function, and [function settings](environments-and-deploys.md#function-settings).
  - **`failed` or a 500:** read that run's log lines, which hold IDs, event names and error names only:

    ```bash
    appwrite functions get-execution --function-id <fn> --execution-id <id> --json | jq -r '.errors, .logs'
    ```

    Post the function, the execution ID and the lines' `event`, `code` and `cause` on #96.

### 4b. A blocked send logs once (#469)

Only while 1b showed sends are blocked. Each step stops at its first blocked email, logs one line, and changes nothing: no reminder marked, no summary moved on, no change notice deleted, no auto-send window closed ([conventions](conventions.md#functions)).

```bash
for fn in scheduler statements identity; do
  appwrite functions list-executions --function-id "$fn" --json \
    --queries '{"method":"equal","attribute":"trigger","values":["schedule"]}' \
    --queries '{"method":"equal","attribute":"status","values":["completed","failed"]}' \
    --queries "{\"method\":\"greaterThan\",\"attribute\":\"\$createdAt\",\"values\":[\"$DEPLOYED_AT\"]}" \
    --queries '{"method":"orderDesc","attribute":"$createdAt"}' \
    --queries '{"method":"limit","values":[1]}' \
    | jq -r --arg f "$fn" '(.executions // [])[] | "== \($f) \(.["$id"]) \(.["$createdAt"]) \(.status)", (((.errors // "") + "\n" + (.logs // "")) | split("\n")[] | fromjson? | select((.cause // "") | startswith("EmailError")) | "\(.event) \(.cause)")'
done
```

Each finished run prints a `==` line, then one line per email failure. Count the lines under each.

- **Pass:** a `==` line for each function, and under it **at most one** line for each of these, with a cause that's a blocked send (`EmailError validation_error 403` or `401`, `EmailError invalid_api_key <status>`, or `EmailError missing_config`):
  - `scheduler`: `reminder_failed`, `summary_failed`, `transaction_changes_failed`;
  - `statements`: `auto_send_failed` or `auto_send_notice_failed`, one of the two;
  - `identity`: `change_notice`.

  Until #476 merges, `statements` can also log `ready_email_failed` once per admin of each statement the run drafted. No email line at all is a pass too, if nothing was due to send. **But if 1b showed a 403 and no step has logged a blocked line after two hours,** check that something was due, such as a bill's reminder or a summary, before calling it a pass. A step that failed some other way would have made 4a's run a 500.
- **No `==` line** for a function: no finished run since the deploy yet. Wait and run it again.
- **If it fails:** two or more lines with the same event and a blocked-send cause mean that step didn't stop. Post the function, event and count on #96 (AI A wrote #475). A cause of `EmailError validation_error 400` or `422` is an address Resend refused, which is expected now and then.

### 4c. Step 3b's checkpoint

Step 3b (#445, #461) makes the `transaction-changes` checkpoint at the start of the hour of its first run. It moves it an hour at a time, once that hour's emails are sent, and only from a run at least an hour and a minute after the hour it covers.

```bash
appwrite tablesdb get-row --database-id main --table-id checkpoints --row-id transaction-changes --json | jq -r .through
```

- **Pass:** a date on the hour, after the scheduler's first run. **While sends are blocked** (1b), it stays at the first hour that has an email to send, by design (#475), and moves again once sends work. A stale window is skipped after 23 hours.
- **If it fails:**
  - **"Row with the requested ID could not be found"** after the scheduler's first run: step 3b didn't run.
  - **It doesn't move** although 1b showed sends work: step 3b is stuck.

  Either way, read the run's lines as in 4a. `transaction_changes_skipped` is a warning, so look in `.logs` as well as `.errors`. Post them on #96.

## 5. Clean up

- **The owner deletes both one-off keys** in Appwrite → Overview → Integrations → API keys. The CLI keeps the checks key in its own settings, so deleting it on the server is what matters.
- **The lead ticks the items** in #299 section 5, and posts the results on #96: pass or fail for each step, with counts and IDs only.

## Not in this runbook

#299 section 5's other checks are by hand, with a test account in the app, or in the console. They stay on #299:
- the password events (#289) and the auth settings (#316);
- placeholders with two identities (#304);
- the bundle sizes (#270);
- the invite flows (#371, #403 item 5);
- history across groups (#424);
- a wrong address counted once (#274).
