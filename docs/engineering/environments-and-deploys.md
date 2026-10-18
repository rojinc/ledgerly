# Environments and deploys

## Environments

| Environment | Appwrite project | Deployed by | Data |
| --- | --- | --- | --- |
| **dev** | `ledgerly-dev` | every merge to `main` | test data only; may be reset |
| **prod** | `ledgerly-prod` | a `v*` tag on `main` | real users |

- Create both projects in the **same Appwrite Cloud region**, as close to users as possible (Sydney for Australia, if offered on the plan).
- Prod runs on the **Pro** plan (higher limits, backups). Dev can run on Free.
- Each project needs a web platform for its app domain (and `localhost` in dev), Resend as custom SMTP, and email verification turned on.

## Resources as code

All Appwrite resources are described in files and pushed with the Appwrite CLI. **Nobody edits tables, buckets or functions in the Appwrite console.** A change made by hand gets overwritten on the next deploy.

```
appwrite.config.json        projectId = dev,  includes appwrite/*.json
appwrite.config.prod.json   projectId = prod, includes the same appwrite/*.json
appwrite/tables.json        every table, column and index (must match data-model.md)
appwrite/buckets.json
appwrite/functions.json     runtime, entrypoint (dist/main.js), schedule, execute, timeout
```

The two config files share the resource files (the CLI's `includes` field), so dev and prod can't drift. Check the exact `includes` syntax against the Appwrite CLI docs in the M0 task.

## CI/CD (GitHub Actions)

`ci.yml`, on every pull request: `npm ci` → lint → typecheck → test → build.

`deploy.yml`:

| Trigger | Steps |
| --- | --- |
| push to `main` | build → `appwrite client -e $ENDPOINT -p $DEV_PROJECT -k $DEV_KEY` → `appwrite push table --all --force` → `appwrite push bucket --all --force` → `appwrite push function --all --force` → deploy web to Appwrite Sites |
| tag `v*` | same steps with `--config-file appwrite.config.prod.json` and prod secrets, behind a GitHub environment that needs owner approval |

GitHub secrets: `APPWRITE_ENDPOINT`, `APPWRITE_DEV_PROJECT_ID`, `APPWRITE_DEV_API_KEY`, `APPWRITE_PROD_PROJECT_ID`, `APPWRITE_PROD_API_KEY`.

## Function settings

| Function | Trigger | Execute | Timeout |
| --- | --- | --- | --- |
| `ledger` | HTTP | `users` | 15 s |
| `groups` | HTTP | `users` | 15 s |
| `identity` | HTTP | `users` | 15 s |
| `scheduler` | HTTP + cron `5 * * * *` | `users` | 900 s |
| `statements` | HTTP + cron `15 * * * *` | `users` | 300 s |

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
