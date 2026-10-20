# Environments and deploys

## Environments

| Environment | Appwrite project | Deployed by | Data |
| --- | --- | --- | --- |
| **the one environment** | `ledgerly-dev` | every merge to `main` | **real users** |

There is no separate prod project for now (owner decision, 2026-10-19). `ledgerly-dev` is production: never reset it, never load test data that could reach real users, and keep schema changes add-only ([below](#schema-changes)).

- The project is in Appwrite Cloud's Sydney region, close to its users.
- With real users on it, it needs the **Pro** plan (higher limits, backups): the owner's call (#3).
- It needs a web platform for its app domain (and `localhost` for local development), Resend as custom SMTP, and email verification turned on.
- Auth methods: only email + password and email OTP (phone from M3). Team invites, magic URL and anonymous are off, because clients never manage team memberships.
- Membership privacy: team members see only each other's user ID, not email, phone, name, MFA or last access.
- Session invalidation (Auth → Security, on since 2026-10-19): a password changed through the password route signs the user out of every other session. A recovery reset doesn't: Appwrite applies the setting only to that route ([#290](https://github.com/rojinc/ledgerly/issues/290)). Like the settings above, no deploy pushes it.

## Resources as code

All Appwrite resources are described in files and pushed with the Appwrite CLI. **Nobody edits tables, buckets or functions in the Appwrite console.** A change made by hand gets overwritten on the next deploy.

```
appwrite.config.json        projectId = ledgerly-dev, includes appwrite/*.json
appwrite/tables.json        every table, column and index (must match data-model.md)
appwrite/buckets.json
appwrite/functions.json     runtime, entrypoint (dist/main.js), schedule, execute, timeout
appwrite/sites.json         the web app (Appwrite Sites), uploaded already built
```

The config file lists the resource files through the CLI's `includes` field. `appwrite push` rewrites these files with its own formatting; never commit that rewrite, because Biome would fail on it.

## CI/CD (GitHub Actions)

`ci.yml`, on every pull request and every push to `main`: `npm ci` → lint → typecheck → test (`TZ=UTC`) → `@ledgerly/core` coverage (`TZ=Australia/Sydney`, 100% required) → test again (`TZ=Australia/Sydney`) → build.

`deploy.yml`:

| Trigger | Steps |
| --- | --- |
| push to `main` | `npm ci` → `npm run build` (the web app with `VITE_APPWRITE_ENDPOINT` and `VITE_APPWRITE_PROJECT_ID`) → install `appwrite-cli` (pinned) → `appwrite client -e $ENDPOINT -p $PROJECT -k $KEY` → the table plan and the table check ([schema changes that lose data](#schema-changes-that-lose-data)) → `appwrite push table` and `bucket` (`--all --force`) → every function's and the site's settings (`--no-code`) → code only for what changed (below) |
| **Run workflow** on `main`, by a person | the same steps, but every function and the site get new code: a full redeploy of `main`'s latest commit, one deployment each. Use it after changing a project variable, since Appwrite then marks every function as needing a redeploy. Agents never run it (AGENTS.md). |

- **One deploy at a time,** and a running one is never cancelled.
- **Only what changed gets new code.** The plan allows **200 deployments a day** (it resets at 00:00 UTC), and every function or site push with code is one, changed or not. So the step "Choose what to deploy" finds the last run whose push step succeeded (through the GitHub API, `actions: read`), and gives new code only to:
  - **a function** whose folder changed, or `packages/core`, `packages/server`, `appwrite/functions.json` or `scripts/build-functions.mjs`;
  - **the site** if `apps/web`, `packages/core` or `appwrite/sites.json` changed;
  - **both,** if `package.json`, `package-lock.json`, `tsconfig.base.json`, `.nvmrc`, `appwrite.config.json` or `deploy.yml` changed.

  - **What counts as changed:** every file that any commit since that run's own commit touched (`git log`), not just the difference between the two commits. So a change that a failed run had already pushed, and that was then reverted, gets new code again. That run's commit can be older than what it deployed (it deploys `main`'s latest), which only pushes more than needed.
  - **Everything deploys, with a warning,** when none of the last 20 successful runs pushed, the run found is outside `main`'s history, or the API fails. The run is found by the push step's name, so renaming that step deploys everything until a run with the new name succeeds.
  - Every run still pushes tables and buckets, and every function's and the site's settings with `--no-code`, which makes no deployment (the CLI still prints "Successfully deployed"). A function that wasn't pushed keeps the commit its last deploy built in `/health`.
- **Every run deploys `main`'s latest commit, never an older one.** `push table --force` makes the database match the commit's `tables.json`, so deploying an older commit would drop columns added since, with their data.
  - **A run for an older commit** (or a re-run of one made after #298) deploys `main`'s latest instead, with a notice naming both commits. The checkout step names `ref: main` for this: without it, `actions/checkout` resets `origin/main` to the run's own commit, so the run can't see anything newer.
  - **Why it doesn't skip:** merges that land together can leave an older commit's run as the only one that survives, since `concurrency` keeps one pending run and cancels the rest. A skip would leave `main`'s latest undeployed.
  - **Two exceptions,** where the run fails without deploying and a person runs **Deploy** on `main`:
    - A run's steps come from its own `deploy.yml`, so the run fails if `deploy.yml` changed between its commit and `main`'s latest.
    - The run's commit isn't in the history of `main`'s latest.
  - **Never re-run a Deploy run from before #298.** Its steps don't check out `main`, so it deploys its own, older commit. Runs #1–#16 also have no table plan, so a re-run would push their `tables.json` with `--force` and delete newer tables. For example, `reminders` would go, with its data. Use **Run workflow** on `main` instead.
  - **A run on another branch** fails.
  - **To undo a change,** revert it on `main`.
- **A table push stops before it deletes or recreates anything the checks can see.** The plan, and then a check that the server has exactly the config's tables, come first; either one stops the deploy ([schema changes that lose data](#schema-changes-that-lose-data)). A change made on the server in the seconds between the checks and the push isn't caught before it's applied, only reported after.
- **The CLI can exit 0 when a resource fails to push** (for example "Deployed 4 of 5 functions … 1 failed."), or when `--all` skips one that lacks a setting (`Skipping it: set "entrypoint" …`). So each push runs under `pipefail` and also fails on any `✗`, "… failed." or "Skipping it:" line in the CLI's output. `appwrite push all` can't be used: it needs a console login, not an API key.
- **The CLI takes the endpoint from `APPWRITE_ENDPOINT` over the config file's,** so nothing in the CLI notices a mismatch. The workflow checks that `APPWRITE_ENDPOINT` is exactly the config's `endpoint` and that the project secret matches its `projectId` before it pushes.
- **The API key** is passed only to the two steps that use it, never to `npm ci` or the build.
- **Until the secrets exist (#3),** a deploy is skipped with a warning. One with only some of its secrets fails instead.
- **The web app** (`appwrite/sites.json`) is the static site `web` ("Ledgerly web"), at `https://ledgerly.appwrite.network`.
  - CI builds it and uploads the contents of `apps/web/dist`, with no install or build command, so Appwrite only serves the files and never runs `npm install` (the same reason as for functions, below).
  - Its settings match the site the owner created: framework `other`, runtime `static-1`, adapter `static`, output `./`, logging off. `push site` writes them back on every deploy. The CLI refuses to change a site's framework ("Framework mismatch"), so that would need the site deleted in the console first: an owner's job.
  - `fallbackFile` is `index.html`, so client routes such as `/shifts/123` load the app.

GitHub secrets: `APPWRITE_ENDPOINT`, `APPWRITE_DEV_PROJECT_ID`, `APPWRITE_DEV_API_KEY`.

**Owner setup for deploys (#3):**
- Add the three secrets as repository secrets. `APPWRITE_ENDPOINT` must be exactly the config's `endpoint` (`https://syd.cloud.appwrite.io/v1`).
- Give the API key exactly the [deploy key's scopes](#the-deploy-keys-scopes).
- The web site's domain (`ledgerly.appwrite.network`) is a manual rule made once in the Appwrite console: an API key can't create it.
- **Who can deploy:** every merge to `main`, and anyone who can press **Run workflow**. Agents work through the owner's GitHub account, so GitHub can't tell them apart from the owner: "agents never run a deploy by hand" is a process rule (AGENTS.md).

### The deploy key's scopes

Each scope is what Appwrite (1.8.1 and 1.9.7, checked in their source) checks on a route that CLI 28.7.0 calls during the deploy. A route that names two scopes accepts either one.

| Scope | Why |
| --- | --- |
| `databases.read` | `push table` first lists the databases (`GET /tablesdb`). |
| `collections.read` | `push table` and the table check list and read tables (`/tablesdb/main/tables…`, which also accept `tables.read`), and `push table` reads columns and indexes through the old `/databases/main/collections/…/attributes` and `/indexes` routes, which accept only this one. |
| `collections.write` | `push table` creates and updates tables (also accepts `tables.write`), and creates and updates columns and indexes through the old `collections` routes, which accept only this one. |
| `buckets.read`, `buckets.write` | `push bucket` reads, creates and updates the buckets in `buckets.json`. |
| `functions.read`, `functions.write` | `push function` reads and updates each function's settings and uploads a new deployment. |
| `sites.read`, `sites.write` | `push site` does the same for the web site. |
| `rules.read` | `push site` reads the site's domain rules, and fails without it. |

Leave out everything else:
- **`databases.write`:** so the server itself refuses to delete (or create) a database. A new database is the lead's job, by hand.
- **`rows.*` and `documents.*`:** a deploy never reads or writes data.
- **`tables.*`:** every table route also accepts `collections.*`, which the column and index routes need anyway.

No scope can stop a table, column or index from being deleted: the scope that creates one (`collections.write`) also deletes it. The [plan and the table check](#schema-changes-that-lose-data) stop those deletes instead.

The owner confirms these names against the server: a missing scope fails the deploy with `missing scopes (["…"])`, naming what that route accepts.

## Function settings

| Function | Trigger | Execute | Timeout | Key scopes |
| --- | --- | --- | --- | --- |
| `ledger` | HTTP | `users` | 15 s | `rows.*`, `files.*` (receipt permissions), `teams.read` (whether a `left` member is still in the team, #117) |
| `groups` | HTTP | `users` | 15 s | `rows.*`, `teams.*` |
| `identity` | HTTP + every 60 minutes (`interval: 60`; [finishing merges](../architecture/identity-and-invites.md#finishing-merges)) + events `users.*.update.password` and `users.*.recovery.*.update` ([password notice](../architecture/identity-and-invites.md#password-notice)), `users.*.update.email` and `users.*.update.phone` ([change notice](../architecture/identity-and-invites.md#email-and-phone-change-notice)) | `users` | 15 s | `rows.*`, `teams.*` (a merge adds U to P's teams), `users.read` (verified identities) |
| `account` | HTTP + every 60 minutes (`interval: 60`) | `users` | 900 s (the hourly job finishes account deletions; `POST /delete` stops after 20 s, inside the 30 s synchronous limit) | `rows.*`, `teams.*`, `users.read` (the caller's session age and `passwordUpdate`, and the users labelled `deleted`), `users.write` (labelling, blocking and deleting a deleted account's user and sessions), `files.read` and `files.write` (a purged group's receipts and statement PDFs, checked before each delete) |
| `scheduler` | HTTP + every 60 minutes (`interval: 60`) | `users` | 900 s | `rows.*`, `files.*` (receipt clean-up, on the `receipts` bucket only), `teams.read` (whether a `left` member is still in the team, #117), `teams.write` (only the [nightly check](../architecture/scheduling.md#step-6-nightly-check), removing stale memberships and putting one back), `users.read` (reminder emails) |
| `statements` | HTTP + every 60 minutes (`interval: 60`) | `users` | 300 s | `rows.*`, `files.*` (PDFs), `teams.read` (whether a `left` member is still in the team, #117) |

**Intervals, not cron.** `ledgerly-dev`'s organisation is on Appwrite's GitHub Student Pack plan: `functionsAllowCron` is false and `functionsIntervalMinimum` is 60. So every function that runs on its own gets `interval: 60` in `functions.json`, never a cron `schedule` (the push fails with "Your current plan doesn't support cron schedules"). Appwrite picks each function's minute within the hour itself, and doesn't document how, so nothing may depend on the minute a run starts or on one function running before another. Runs of different functions overlap routinely, and each step's guards make that safe. A time such as 07:00 means the first run at or after it. Appwrite queues an interval run like a cron run, as `POST /` with `x-appwrite-trigger: schedule` and no JWT.

Every function runs on `node-24`, the same Node as `.nvmrc`, CI and the build's `/health` check. Node 24 gets security fixes [until 2028-04-30](https://github.com/nodejs/Release); before then, move to the next LTS runtime. Check what Cloud offers with `functions.listRuntimes` on the project (on 2026-10-18 `ledgerly-dev` listed `node-22`, `node-24`, `node-25` and `node-26`), not the runtimes page, which lags. The CLI refuses to change a deployed function's runtime, so a move means deleting and recreating each function.

Each function runs from a bundle: `npm run build` writes `functions/<name>/dist/main.js` with esbuild, and the deployment uploads only `dist/` and `package.json` (`ignore: ["*", "!dist/", "!dist/**", "!package.json"]`, which also holds under strict `.gitignore` rules). Never add a `.gitignore` inside `functions/<name>/`: the CLI applies it on top of `ignore`, so one that lists `dist/` would leave the bundle out.

- **The `statements` bundle carries font files** for the invoice PDF ([statements.md](../architecture/statements.md#invoice-pdf-layout-employer)). The build empties `functions/statements/dist/fonts/` and copies them in. It fails if one is missing or its SHA-256 differs from the one in `scripts/build-functions.mjs`, and the statements `GET /health` fails too when they aren't beside the bundle, so the build's `/health` check proves the path:
  - `NotoSansCJKsc-Regular.otf` (16.4 MB), committed under `packages/server/fonts/` with its licence, from notofonts/noto-cjk tag `Sans2.004`;
  - `NotoEmoji_400Regular.ttf` (0.9 MB), from the devDependency `@expo-google-fonts/noto-emoji`, pinned to `0.4.8`.

  The deployment is then 15.4 MB as `.tar.gz` (#270). A self-hosted Appwrite allows 30 MB (`_APP_COMPUTE_SIZE_LIMIT`); Cloud's plan doesn't publish its limit.
- **`commands` stays empty.** The uploaded `package.json` names `@ledgerly/*` packages, which aren't on public npm, so an `npm install` could pull a stranger's package of the same name. The bundle already holds every dependency.
- **Key scopes** are those of the ephemeral key in `x-appwrite-key` (`.*` = `read` and `write`). Give a function only the scopes a documented route needs; a change to them gets the `security` label.
- `GET /health`, the only route that runs without a signed-in caller, returns `{ fn, version }` on every function, where `version` is the commit the bundle was built from (`-dirty` when built with uncommitted changes).

Project variables (Appwrite → Settings → Variables): `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, `SUPPORT_EMAIL` (the address the [change notice](../architecture/identity-and-invites.md#email-and-phone-change-notice) tells a user to write to; optional, the owner sets it on #3. Without it the notice says "reply to this email", which only works if someone reads the `EMAIL_FROM` inbox), later `SMS_*` and `SENTRY_DSN`.

## Schema changes

The Appwrite CLI **deletes columns that disappear from the config** when it pushes. So:

1. **Add, don't remove.** New columns are optional or have defaults, so old code keeps working.
2. Deploy code that no longer uses a column **before** removing the column, in a later PR.
3. Renaming = add the new column → backfill (script in `scripts/`) → switch code → remove the old column. That's at least two releases.
4. Changing a column's type recreates it and **loses its data**. Treat it as a rename.
5. Every schema PR has the `contract` label and a "Migration" section in its description, even if that section says "additive, none needed".

### Schema changes that lose data

`push table --force` (Appwrite CLI 28.7.0) applies, without asking, every change that loses data: it **deletes and recreates** a column whose `type`, `array`, `format` or `encrypt` differs from the server's, or an index whose type, columns or orders differ (`asc` and `ASC` count as different orders), and **deletes** columns, indexes, tables and databases that aren't in the config. The CLI has no dry run. So before it pushes, the deploy runs `scripts/appwrite-table-plan.py`: `push table` without `--force`, in a pseudo-terminal that answers "n" to every question, which prints every change and applies none that needs approval. The deploy stops, with nothing destructive applied, if the plan fails or shows:

- `recreating` or `deleting` (a column, index or database), or `(deleted locally)` (a table or database);
- `Skipping push action` (a changed table or database setting, or a new database, which stops the CLI before it compares columns), or it times out after 600 s, since the plan is then incomplete.

New tables and their columns are created during the plan, as the push would create them.

CLI 28.7.0 ignores a failed request for the list of tables, and then finds no table to delete, so one failed request would hide a table from the plan that the push then deletes. So after the plan, the **table check** lists the server's tables again (`appwrite tablesdb list-tables`, with `--database-id main` written into the step, which is right while `main` is the only database) and stops the deploy on any error, or on any table that's only on the server or only in the config.

After the real push, a `recreating`, `deleting`, `(deleted locally)` or `Deleting …` line in its output fails the deploy too: that reports a change made to the server since the checks. Only the table push is read for these words, since function and site build logs can contain them.

A failed read of a table during the plan (the request that carries its columns and indexes) fails the plan, which stops the deploy. Only the list of tables is read without a check, which is why the table check exists.

**Changing the CLI pin needs a re-test first.** The plan and the greps match strings that CLI 28.7.0 prints:
- the prompts' help line `y Yes • n No`;
- `recreating`, `deleting` and `(deleted locally)` in the plan;
- `Skipping push action`;
- `Deleting …` after the push.

If a new version renames any of them, the gate misses a change that `--force` then applies. So before the pin in `deploy.yml` changes, re-run the plan and the step's script against a stub of the API, as #275 did, with a column type change, a column and a table missing from the config, a changed table setting, and a failed list request. Then update this section.

**When the plan stops a deploy:**
- **The file is wrong** (a type that differs only in name, as `string` for a plain text column the server reports as `varchar`): fix `tables.json`. `tables.test.ts` checks the text column types.
- **The server is wrong** (something made by hand, or an index with lower-case orders): the lead fixes the server with the Appwrite MCP, then re-runs the deploy.
- **The change is meant to lose data:** follow the steps above (a later PR, a backfill), and the lead applies the destructive step by hand, once, after a backup.

A deploy stops, instead of deleting it, at anything made on ledgerly-dev ahead of `main` (a table, column or index from an open contract PR), until `main` has it too.

## Backups

`ledgerly-dev` has real users, so it uses Appwrite's managed backups (Pro plan). Before any destructive migration, take a manual backup and note its ID in the PR.
