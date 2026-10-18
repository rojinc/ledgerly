# AGENTS.md

Rules for every coding agent (Claude Code, Codex, others) and every person working in this repo. Details live in [`docs/`](docs/README.md); this file is the short version you must always follow.

## Before you write code

1. Work only on a GitHub issue labelled `status:ready` whose dependencies are closed. Claim it first (label + comment). See [multi-agent workflow](docs/collaboration/multi-agent-workflow.md).
2. Read, in this order:
   - [docs/collaboration/multi-agent-workflow.md](docs/collaboration/multi-agent-workflow.md)
   - [docs/architecture/overview.md](docs/architecture/overview.md)
   - [docs/architecture/ledger.md](docs/architecture/ledger.md) if your task touches money in any way
   - the docs listed under **Read first** in your issue
3. Make your own branch (`<type>/<issue>-<slug>`) in your own git worktree.

## Rules that always apply

- **Stay inside your issue's Scope paths.** Need more? Comment on the issue and ask.
- **Never** push to `main`, force-push someone else's branch, edit Appwrite resources in the console, or commit secrets or `.env` files. Only the **lead agent** merges PRs, after a review by a different agent ([who merges](docs/collaboration/multi-agent-workflow.md#roles)).
- **Money is integer cents.** Splitting always uses `allocate()`. Never use floats for money.
- **Dates are `YYYY-MM-DD` strings in the group's timezone.** Never `new Date('YYYY-MM-DD')`. Use the date helpers in `packages/core`.
- **Clients never write to the database.** Every write goes through a function ([D-003](docs/architecture/decisions.md)).
- **Every ledger write keeps the [invariants](docs/architecture/ledger.md#invariants)** and runs in one TablesDB transaction.
- **Contracts change first, separately:** the data model, function API, zod schemas and ledger rules change in their own `contract` PR, approved by the lead agent.
- **Keep it simple.** Write the smallest change that meets the acceptance criteria. No speculative abstractions, no empty folders, no barrel `index.ts` files. Reuse what exists.
- **No new dependency** without one line in the PR saying why ([conventions](docs/engineering/conventions.md#dependencies)).
- **Tests:** money and date logic in `packages/core` needs full branch coverage, including invariant tests. Never skip or delete a failing test to get green.
- **Docs:** if behaviour, an API, the schema or a rule changes, update `docs/` in the same PR. Docs win over code until changed.
- **No personal data in logs.**

## Commands

Available once the M0 tooling lands:

```bash
npm ci              # install
npm run lint        # Biome
npm run typecheck   # TypeScript
npm test            # Vitest
npm run build       # web + function bundles
npm run dev         # web app against the dev Appwrite project
```

Run lint, typecheck, test and build before you mark a PR ready.

## Repo map

```
apps/web/          React + Vite PWA (features/<feature>/ per feature)
packages/core/     pure TypeScript domain logic: money, dates, ledger, schemas (no I/O)
packages/server/   helpers for functions only (Appwrite client, auth, email, pdf)
functions/<name>/  Appwrite Functions: ledger, groups, identity, scheduler, statements
appwrite/          tables, buckets, functions as code
docs/              design docs (GitBook)
```

## Definition of done

- [ ] Acceptance criteria in the issue are all met
- [ ] Lint, typecheck, tests and build pass
- [ ] New logic has tests; bug fixes start with a failing test
- [ ] Docs updated if anything they describe changed
- [ ] PR uses the template, says `Closes #<issue>`, stays inside Scope, and lists any new dependency with a reason
