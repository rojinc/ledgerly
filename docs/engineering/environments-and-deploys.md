# Environments and deploys

## Environments

| Environment | Appwrite project | Deployed by | Data |
| --- | --- | --- | --- |
| **dev** | `ledgerly-dev` | every merge to `main` | test data only; may be reset |
| **prod** | `ledgerly-prod` | a `v*` tag on `main` | real users |

- Create both projects in the **same Appwrite Cloud region**, as close to users as possible (Sydney for Australia, if offered on the plan).
- Prod runs on the **Pro** plan (higher limits, backups). Dev can run on Free.
- Each project needs a web platform for its app domain (and `localhost` in dev), Resend as custom SMTP, and email verification turned on.
- Auth methods: only email + password and email OTP (phone from M3). Team invites, magic URL and anonymous are off, because clients never manage team memberships.
- Membership privacy: team members see only each other's user ID, not email, phone, name, MFA or last access.

## Resources as code

All Appwrite resources are described in files and pushed with the Appwrite CLI. **Nobody edits tables, buckets or functions in the Appwrite console.** A change made by hand gets overwritten on the next deploy.

```
appwrite.config.json        projectId = dev,  includes appwrite/*.json
appwrite.config.prod.json   projectId = prod, includes the same appwrite/*.json
appwrite/tables.json        every table, column and index (must match data-model.md)
appwrite/buckets.json
appwrite/functions.json     runtime, entrypoint (dist/main.js), schedule, execute, timeout
```

The two config files share the resource files through the CLI's `includes` field, so dev and prod can't drift. `appwrite push` rewrites these files with its own formatting; never commit that rewrite, because Biome would fail on it.

## CI/CD (GitHub Actions)

`ci.yml`, on every pull request and every push to `main`: `npm ci` → lint → typecheck → test (`TZ=UTC`) → `@ledgerly/core` coverage (`TZ=Australia/Sydney`, 100% required) → build.

`deploy.yml`:

| Trigger | Steps |
| --- | --- |
| push to `main` | build → `appwrite client -e $ENDPOINT -p $DEV_PROJECT -k $DEV_KEY` → `appwrite push table --all --force` → `appwrite push bucket --all --force` → `appwrite push function --all --force` → deploy web to Appwrite Sites |
| tag `v*` | same steps with `--config-file appwrite.config.prod.json` and prod secrets, behind a GitHub environment that needs owner approval |

GitHub secrets: `APPWRITE_ENDPOINT`, `APPWRITE_DEV_PROJECT_ID`, `APPWRITE_DEV_API_KEY`, `APPWRITE_PROD_PROJECT_ID`, `APPWRITE_PROD_API_KEY`.

## Function settings

| Function | Trigger | Execute | Timeout | Key scopes |
| --- | --- | --- | --- | --- |
| `ledger` | HTTP | `users` | 15 s | `rows.*`, `files.*` (receipt permissions) |
| `groups` | HTTP | `users` | 15 s | `rows.*`, `teams.*` |
| `identity` | HTTP | `users` | 15 s | `rows.*`, `teams.*`, `users.read` (verified identities) |
| `scheduler` | HTTP + cron `5 * * * *` | `users` | 900 s | `rows.*` |
| `statements` | HTTP + cron `15 * * * *` | `users` | 300 s | `rows.*`, `files.*` (PDFs) |

Every function runs on `node-22`, the newest Node LTS runtime that Appwrite Cloud offers (Cloud has `node-22` and `node-25`, and Node 25 no longer gets security fixes). Move to a newer runtime only when it is an LTS release that Cloud offers. Each runs from a bundle: `npm run build` writes `functions/<name>/dist/main.js` with esbuild, and the deployment uploads only `dist/` and `package.json` (`ignore: ["*", "!dist/", "!package.json"]`; the CLI doesn't read `.gitignore`).

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

Prod uses Appwrite's managed backups (Pro plan). Before any destructive migration in prod, take a manual backup and note its ID in the PR.
