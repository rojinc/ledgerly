# Restore from a backup

The runbook for bringing `main` back from one of Appwrite's backups, and for the drill that tries it once before launch ([#567](https://github.com/rojinc/ledgerly/issues/567)). Step 0 and the drill are launch blockers on [#299](https://github.com/rojinc/ledgerly/issues/299). A real recovery (section 2) follows the path the drill proved.

**Who runs what:**
- **The owner** checks the plan, takes the backups, runs the restores, makes and deletes the drill's databases, makes and deletes the one-off keys, and writes 2d's marks. Accounts, the console and production are the owner's ([D-015](../architecture/decisions.md#d-015-the-lead-agent-runs-the-project-day-to-day)).
- **The lead** holds and lifts the merge hold on #96, runs `scripts/restore-check.mjs`, and posts the results.
- **No other agent** runs any of it (AGENTS.md).

**What writes:**
- **Step 0:** a Daily backup policy, if there's none, and one manual backup.
- **The drill:**
  - a manual backup of `main`, and a copy of it restored alongside as `drill-<YYYYMMDD>`, which holds every user's rows until it's deleted in the same sitting;
  - a throwaway database `drill-inplace`, with one table and four rows, a backup of it, and an in-place restore;
  - both drill databases are deleted at the end, with the one-off key.
- **A real recovery:**
  - a manual backup of `main` as it is;
  - the in-place restore, which **loses every write made since the backup**;
  - then the marks that finish deletions made since the backup (2d).

| Step | When | Who | What it proves |
| --- | --- | --- | --- |
| [0](#0-the-plan-has-backups) | once, before launch | owner | `ledgerly-dev`'s plan has backups, a Daily policy is on, and a manual backup works |
| [1a](#1a-a-copy-of-main-alongside) | the drill | owner, lead | a backup of `main` restores whole: every table, the balances and the statement PDFs |
| [1b](#1b-an-in-place-restore-on-a-throwaway-database) | the drill | owner | how an in-place restore is done, and whether it replaces or merges rows |
| [1c](#1c-the-result) | the drill's end | owner, lead | both drill databases are gone, and the merge hold is lifted |
| [2](#2-a-real-recovery) | when `main` has to go back | owner, lead | `main` is back as of the backup, with deletions since then finished again |

Run the drill once before launch, and again after any change to the plan or the backup policy.

## Before you start

- **Tools:** Node from `.nvmrc` and a checkout of `main`. The check script uses Node's built-ins only, so it needs no `npm ci`.
- **A one-off check key** (owner: Appwrite → Overview → Integrations → API keys) with only `rows.read`, `files.read`, `users.read` and `teams.read`. The script reads users and teams only to tell which are gone, and keeps their IDs only. Step 1c (or 2f) deletes the key.
- **Give the script the key** without it reaching your shell history:

  ```bash
  read -r DATABASE_ID   # the database to check: drill-YYYYMMDD in 1a, main in 2c
  read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
  export APPWRITE_ENDPOINT=https://syd.cloud.appwrite.io/v1 APPWRITE_PROJECT_ID=ledgerly-dev
  node scripts/restore-check.mjs --database-id "$DATABASE_ID"
  unset APPWRITE_API_KEY
  ```

- **Post IDs, counts and pass or fail only.** The script prints nothing else: no row's content, no name, no address, no key.

## What a restore brings back, and what it leaves out

Sources: Appwrite's [backups page](https://appwrite.io/docs/products/databases/tablesdb/backups) and the Node SDK's `Backups` service.

- **Appwrite documents backups for Pro and Enterprise customers only.** Pro gets one Daily policy, and a manual backup at any time. Its pages don't say whether the Education or GitHub Student Pack plan has them, or how long Pro's Daily policy keeps a backup: step 0 reads both off the console.
- **A backup holds one database's rows,** so a restore brings back rows only. The backups page covers databases only, and the Storage, Auth and Functions pages never mention backups. So assume that a restore leaves these as they are now:
  - **bucket files:** a restored row can name a receipt or a statement PDF deleted since the backup (the check lists the statements), and a file uploaded since can lose the row that named it;
  - **Auth users, sessions and teams:** a user or team deleted since the backup stays gone, but its rows come back. That's what 2d finishes;
  - **functions, keys, platforms and settings.**
- **The database's ID is fixed in code** as `main` (`packages/server/src/appwrite/tables.ts`, `apps/web/src/lib/appwrite.ts` and `deploy.yml`). A copy restored under another ID is for checking only: the app can't use it without a code change and a deploy.
- **Not documented:** how long a restore takes, what happens to writes made while it runs, and whether an in-place restore replaces the rows or merges them. 1b shows the last one.

## 0. The plan has backups

The owner, once, before launch: Appwrite console → Databases → `main` → the **Backups** tab.

| Answer | Means | Then |
| --- | --- | --- |
| The tab lists a Daily policy | backups are on | note the policy's retention (how long it keeps each backup), take one **Manual Backup**, and check that it reaches the list as completed |
| The tab is there, with no policy | the plan has backups, but none are taken | **Create Policies** → Daily → **Create**, then as the first row |
| No Backups tab, or an upgrade prompt | this plan has no backups | **launch waits** for the owner's plan decision ([#3](https://github.com/rojinc/ledgerly/issues/3), the lead's Q1 on #567). Nothing else in this runbook can run. |

Post on #567: the plan, the policy and its retention. Then the lead updates [environments and deploys](environments-and-deploys.md#backups), [security and privacy](../architecture/security-and-privacy.md#retention) and the [legal pack](../product/legal-review.md)'s backups row to say the same.

## 1. The drill

**The lead holds all merges first,** with a line on #96, and lifts the hold at 1c. While a drill database exists, a deploy plans to delete it and the [deploy guard](environments-and-deploys.md#schema-changes-that-lose-data) stops the deploy. That's safe, but wasted. The functions read and write `main` only, so they never touch a drill database.

### 1a. A copy of main, alongside

1. **The owner** takes a **Manual Backup** of `main`, and waits until it's completed.
2. **The owner** restores it: on the backup, the options menu → **Restore**. Give it the name and ID `drill-<YYYYMMDD>` (today's date). Wait for the restore to finish.
3. **The lead** runs the check against it (as in [Before you start](#before-you-start)), giving `drill-<YYYYMMDD>` as the database.
4. **The owner deletes `drill-<YYYYMMDD>`** as soon as the check finishes, pass or fail, in the same sitting and before the hold is lifted. It's a second copy of everyone's rows. Note the time it was deleted.

The check prints a line per table with its rows in the copy and in `main`, then a line each for the balances, the statement PDFs, the persons whose user is gone and the groups whose team is gone, each followed by the IDs it lists, then a verdict: `restore check <ID>: PASS`, or the number to act on. Appwrite may cap a table's count at 5,000, so a count is a guide, not a proof.

| Answer | Means | Then |
| --- | --- | --- |
| The counts match, or differ only by the writes since the backup, and `PASS` | the backup restores whole | 1b |
| A table with far fewer rows than `main`, or `0` | the restore left rows out | post the table and both counts on #96. Don't rely on backups until it's explained |
| `balances mismatched <group ID>` | a group's stored balances don't match its rows, as the [nightly check](nightly-check.md) would find | check the same group IDs in `main`: if they match there, the backup missed rows. Post the IDs on #96 |
| `missing PDF <statement ID>` | a final statement's PDF is no longer in the `statements` bucket | expected only for a group purged since the backup, since files aren't restored. Post the IDs on #96 |
| `person to mark` or `group to mark`, or `finishing` | an account or group deleted since the backup (to mark), or whose deletion had started before it (finishing) | expected only for deletions in the minutes since step 1. In a real recovery, 2d finishes them. The finishing ones don't count against `PASS` |
| `FETCH FAILED`, or the usage line (exit 2) | a wrong key, scope, ID or endpoint | fix it and run it again. Nothing was read |

### 1b. An in-place restore, on a throwaway database

This proves the path a real recovery uses, on rows nobody needs. It's the one time a database is made in the console. Nothing in the app uses it, and step 7 deletes it.

1. **The owner** creates a database with the name and ID `drill-inplace`, with one table `t`, one integer column `n`, and three rows: `n` = 1, 2 and 3.
2. Take a **Manual Backup** of `drill-inplace`, and wait until it's completed.
3. Change the row with `n` = 2 to `n` = 20, and add a fourth row with `n` = 4.
4. **The console's in-place restore:** on that backup, **Restore**, and give it the same ID, `drill-inplace`. Write down what happens: it's refused, it makes a second database, or it restores `drill-inplace` itself.
5. **If the console didn't restore in place,** use the API. It restores in place when no new ID is given (`createRestoration` in the SDK's `Backups` service). It needs a key with the backups scope that the error names:

   ```bash
   read -r ARCHIVE_ID   # the backup's ID, from the Backups tab
   read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
   curl -sS -X POST https://syd.cloud.appwrite.io/v1/backups/restoration \
     -H 'Content-Type: application/json' -H 'X-Appwrite-Project: ledgerly-dev' \
     -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
     -d "{\"archiveId\":\"$ARCHIVE_ID\",\"services\":[\"databases\"]}" | jq '{status, options}'
   unset APPWRITE_API_KEY
   ```

   If `databases` is refused as a service, the SDK also lists `tablesdb`: try that, and write down which one worked.
6. **Check the rows:** `n` = 2 is back, not 20. Write down whether the row with `n` = 4 is gone (the restore **replaces** the rows) or still there (it **merges** them).
7. **The owner deletes `drill-inplace`,** and any second database step 4 made, and the key from step 5.

### 1c. The result

The lead posts on #299:

```
Restore drill <YYYY-MM-DD>: 1a <PASS or what failed> (<N> tables, balances <ok or N groups>, missing PDFs <N>), drill-<YYYYMMDD> deleted <HH:MMZ>. 1b in place by <console or API, service "…">, rows <replaced or merged>, drill-inplace deleted <HH:MMZ>.
```

- **The owner deletes the one-off check key.**
- **Then the lead lifts the merge hold** on #96.
- If 1b's path or answer differs from section 2's steps, the lead files a docs PR to correct them before launch.

## 2. A real recovery

Only when the lead and the owner agree that `main` has to go back to a backup, for example after a bad migration. **Every write made since the backup is lost:** say so on #96 first, with the backup's time.

### 2a. Hold merges

The lead holds all merges on #96, until 2f.

### 2b. A backup of main as it is

The owner takes a **Manual Backup** of `main` now, and notes its ID on #96. Restoring that one in place, by the same path, undoes the recovery.

### 2c. Restore in place, and check

1. **The owner restores the chosen backup in place,** by the path 1b proved. Do it when the app is least used: what happens to writes made while it runs isn't documented.
2. **The lead runs the check** with `--database-id main`. It prints one column of counts, and the answers mean what [1a's table](#1a-a-copy-of-main-alongside) says. `main` is live, and the check doesn't stop writes, so a group written to while it runs can show as mismatched: run it again, and only a group listed twice is a finding.

### 2d. Finish the deletions made since the backup

A restore brings back the rows of every account and group deleted since the backup, but not their Auth users or teams. So those are exactly the persons whose user is gone, and the groups whose team is gone. The check lists both, and **each must be deleted again before the app is announced as back** (the lead's Q4 on #567, [security and privacy](../architecture/security-and-privacy.md#retention)).

- **Listed as "finishing"** (a person with `deletedAt` set, or a group with `deletingAt` set): the deletion had started before the backup. The `account` function's next hourly run finishes it by itself ([finishing purges](../architecture/identity-and-invites.md#finishing-purges)).
- **A person "to mark"** (the user is gone and no `deletedAt`): the account was deleted after the backup. Write on its row exactly the mark that `account POST /delete`'s step 2 writes, `deletedAt`, "Former member" and a fresh `rev` (`delete-account.ts`, `markDeleted`), and the hourly run's account pass does steps 3–7. Step 3 and step 7 count a user who is already gone as done ([order](../architecture/identity-and-invites.md#order)). Step 4 purges, or keeps, each of its groups as the deletion did, so a group purged with that account goes too.

  ```bash
  read -r PERSON_ID   # one "person to mark" ID from the check
  appwrite tablesdb update-row --database-id main --table-id persons --row-id "$PERSON_ID" \
    --data "{\"deletedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"displayName\":\"Former member\",\"rev\":\"$(openssl rand -hex 10)\"}" \
    --json | jq -r '.["$id"]'
  ```

- **Then run the check again** after the next hourly run. A group still "to mark" was deleted on its own ([deleting a group](../architecture/identity-and-invites.md#deleting-a-group)). Write on it exactly the mark that `account POST /groups/{id}/delete`'s step 2 writes (`delete-group.ts`): `deletingAt`, `deletingBy` and a fresh `rev`. `deletingBy` is the person ID of a member row the group still has, its admin's if it has one. The hourly run's group pass then purges it, ending with that member's row.

  ```bash
  read -r GROUP_ID      # one "group to mark" ID from the check
  read -r DELETING_BY   # the person ID of a member row it still has
  appwrite tablesdb update-row --database-id main --table-id groups --row-id "$GROUP_ID" \
    --data "{\"deletingAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"deletingBy\":\"$DELETING_BY\",\"rev\":\"$(openssl rand -hex 10)\"}" \
    --json | jq -r '.["$id"]'
  ```

- **The owner runs these commands, never an agent,** with a second one-off key with `rows.write` only, made for this step and deleted in 2f. They're the only rows this runbook writes by hand. Each writes exactly the fields its route's step 2 writes, no more and no fewer, so everything after it runs as it would for a deletion that was cut off (the lead on [#578](https://github.com/rojinc/ledgerly/pull/578)).
- **Post only the person and group IDs on #96,** never a name or an address, and the check's next run, which must list neither.

### 2e. The nightly check

The next [nightly check](nightly-check.md) must pass before the app is announced as back. Post its result on #96.

### 2f. Close

- **The owner deletes the one-off keys.**
- **The lead lifts the merge hold,** and posts on #96 that the app is back, with the backup's time and the nightly check's result.
