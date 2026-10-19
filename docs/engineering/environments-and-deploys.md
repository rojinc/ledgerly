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
| push to `main` | `npm ci` → `npm run build` (the web app with `VITE_APPWRITE_ENDPOINT` and `VITE_APPWRITE_PROJECT_ID`) → install `appwrite-cli` (pinned) → `appwrite client -e $ENDPOINT -p $PROJECT -k $KEY` → `appwrite push table`, `bucket`, `function` and `site`, each with `--all --force` |
| **Run workflow** on `main`, by a person | the same steps: a redeploy of `main`'s latest commit. Agents never run it (AGENTS.md). |

- **One deploy at a time,** and a running one is never cancelled.
- **Only `main`'s latest commit deploys.** `push table --force` makes the database match the commit's `tables.json`, so deploying an older commit would drop columns added since, with their data. A re-run of an older run is skipped with a warning (the newer commit's own run deploys it), and a run on another branch fails. To undo a change, revert it on `main`.
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
- Add the three secrets as repository secrets. `APPWRITE_ENDPOINT` must be exactly the config's `endpoint` (`https://syd.cloud.appwrite.io/v1`). The API key needs the scopes for tables, buckets and functions, plus `sites.read`, `sites.write` and `rules.read` (`push site` reads the site's domain rules, and fails without it).
- The web site's domain (`ledgerly.appwrite.network`) is a manual rule made once in the Appwrite console: an API key can't create it.
- **Who can deploy:** every merge to `main`, and anyone who can press **Run workflow**. Agents work through the owner's GitHub account, so GitHub can't tell them apart from the owner: "agents never run a deploy by hand" is a process rule (AGENTS.md).

## Function settings

| Function | Trigger | Execute | Timeout | Key scopes |
| --- | --- | --- | --- | --- |
| `ledger` | HTTP | `users` | 15 s | `rows.*`, `files.*` (receipt permissions), `teams.read` (whether a `left` member is still in the team, #117) |
| `groups` | HTTP | `users` | 15 s | `rows.*`, `teams.*` |
| `identity` | HTTP | `users` | 15 s | `rows.*`, `teams.*`, `users.read` (verified identities) |
| `account` (#50 Part 3 adds it to `functions.json` with its code) | HTTP + cron `35 * * * *` | `users` | 900 s (the hourly job finishes account deletions; `POST /delete` stops after 20 s, inside the 30 s synchronous limit) | `rows.*`, `teams.*`, `users.read` (the caller's session age and `passwordUpdate`), `users.write` (labelling, blocking and deleting a deleted account's user and sessions), `files.read` and `files.write` (a purged group's receipts and statement PDFs, checked before each delete) |
| `scheduler` | HTTP + cron `5 * * * *` | `users` | 900 s | `rows.*`, `teams.read` (whether a `left` member is still in the team, #117), `teams.write` (only the [nightly check](../architecture/scheduling.md#step-6-nightly-check), removing stale memberships), `users.read` (reminder emails) |
| `statements` | HTTP + cron `15 * * * *` | `users` | 300 s | `rows.*`, `files.*` (PDFs), `teams.read` (whether a `left` member is still in the team, #117) |

Every function runs on `node-24`, the same Node as `.nvmrc`, CI and the build's `/health` check. Node 24 gets security fixes [until 2028-04-30](https://github.com/nodejs/Release); before then, move to the next LTS runtime. Check what Cloud offers with `functions.listRuntimes` on the project (on 2026-10-18 `ledgerly-dev` listed `node-22`, `node-24`, `node-25` and `node-26`), not the runtimes page, which lags. The CLI refuses to change a deployed function's runtime, so a move means deleting and recreating each function.

Each function runs from a bundle: `npm run build` writes `functions/<name>/dist/main.js` with esbuild, and the deployment uploads only `dist/` and `package.json` (`ignore: ["*", "!dist/", "!dist/**", "!package.json"]`, which also holds under strict `.gitignore` rules). Never add a `.gitignore` inside `functions/<name>/`: the CLI applies it on top of `ignore`, so one that lists `dist/` would leave the bundle out.

- **`commands` stays empty.** The uploaded `package.json` names `@ledgerly/*` packages, which aren't on public npm, so an `npm install` could pull a stranger's package of the same name. The bundle already holds every dependency.
- **Key scopes** are those of the ephemeral key in `x-appwrite-key` (`.*` = `read` and `write`). Give a function only the scopes a documented route needs; a change to them gets the `security` label.
- `GET /health`, the only route that runs without a signed-in caller, returns `{ fn, version }` on every function, where `version` is the commit the bundle was built from (`-dirty` when built with uncommitted changes).

Project variables (Appwrite → Settings → Variables): `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, later `SMS_*` and `SENTRY_DSN`.

## Schema changes

The Appwrite CLI **deletes columns that disappear from the config** when it pushes. So:

1. **Add, don't remove.** New columns are optional or have defaults, so old code keeps working.
2. Deploy code that no longer uses a column **before** removing the column, in a later PR.
3. Renaming = add the new column → backfill (script in `scripts/`) → switch code → remove the old column. That's at least two releases.
4. Changing a column's type recreates it and **loses its data**. Treat it as a rename.
5. Every schema PR has the `contract` label and a "Migration" section in its description, even if that section says "additive, none needed".

## Backups

`ledgerly-dev` has real users, so it uses Appwrite's managed backups (Pro plan). Before any destructive migration, take a manual backup and note its ID in the PR.
