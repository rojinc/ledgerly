# Repository structure

One repo, npm workspaces. Every folder has one clear owner area, so parallel tasks rarely touch the same files.

```
ledgerly/
├── AGENTS.md                  rules for every agent and person (Codex reads this)
├── CLAUDE.md                  imports AGENTS.md for Claude Code
├── README.md                  short intro + links
├── package.json               workspaces + root scripts
├── package-lock.json
├── tsconfig.base.json         shared compiler options
├── biome.json                 lint + format
├── .nvmrc                     Node version
├── .editorconfig
├── .gitignore
├── .env.example               names of every env var, no values
├── .gitbook.yaml              GitBook Git Sync → docs/
├── appwrite.config.json       Appwrite CLI config (dev); includes files from appwrite/
├── appwrite.config.prod.json  same resources, prod project
│
├── .github/
│   ├── workflows/             ci.yml, deploy.yml
│   ├── ISSUE_TEMPLATE/        task.yml, bug.yml
│   ├── pull_request_template.md
│   └── CODEOWNERS
│
├── docs/                      these docs (GitBook)
│
├── appwrite/                  Appwrite resources as code
│   ├── tables.json            every table, column and index (matches data-model.md)
│   ├── buckets.json
│   └── functions.json
│
├── packages/
│   ├── core/                  @ledgerly/core: pure TypeScript, no I/O
│   │   └── src/
│   │       ├── money/         allocate, formatMoney, shiftAmount
│   │       ├── dates/         LocalDate helpers, periods
│   │       ├── ledger/        buildShares, splits, invariants
│   │       ├── settle/        balances, suggestTransfers
│   │       ├── recurrence/    expandSchedule, holidays
│   │       ├── statements/    buildStatementSnapshot, checks
│   │       ├── identity/      normalizeIdentity
│   │       ├── schemas/       zod schemas = the API contract
│   │       ├── constants/     kinds, statuses, categories, limits
│   │       └── generated/     row types from `appwrite types` (never edit by hand)
│   └── server/                @ledgerly/server: helpers for functions only
│       └── src/
│           ├── appwrite/      client from function context, table IDs, transaction helper
│           ├── http/          createHandler, AppError, envelope
│           ├── auth/          requireMember, roles
│           ├── identity/      resolvePerson, claim, merge
│           ├── email/         Resend wrapper + templates
│           └── pdf/           pdfmake documents
│
├── functions/                 one folder per Appwrite Function
│   ├── ledger/
│   ├── groups/
│   ├── identity/
│   ├── scheduler/
│   └── statements/
│       ├── src/main.ts
│       ├── src/routes/
│       └── test/
│
├── apps/
│   └── web/                   React + Vite PWA
│       └── src/
│           ├── main.tsx
│           ├── routes.tsx     one line per feature route
│           ├── lib/           appwrite client, callFunction, query keys
│           ├── ui/            shadcn/ui components (generated, then owned)
│           └── features/      one folder per feature
│               ├── auth/
│               ├── groups/
│               ├── calendar/
│               ├── shifts/
│               ├── schedules/
│               ├── transactions/
│               ├── statements/
│               ├── house/
│               ├── people/
│               └── profile/
│
└── scripts/                   small repo scripts (build functions, seed dev data)
```

## Rules

- **Folders exist only once they have code.** Don't create empty folders "for later".
- **No barrel files** (`index.ts` re-exporting a folder). Packages use subpath exports: `import { allocate } from '@ledgerly/core/money/allocate'`. This avoids merge conflicts between parallel tasks ([D-012](../architecture/decisions.md)).
- **`packages/core` has no I/O.** No Appwrite, no network, no `Date.now()` in logic (pass `now` in). That makes it easy to test and lets the web, functions and the future mobile app all share it.
- **`packages/server` is for functions only.** The web app must never import it.
- **Features own their folder.** A feature's components, hooks and queries live in `apps/web/src/features/<feature>/`. Shared UI goes in `ui/`, shared helpers in `lib/`.
- **Generated code** lives in `generated/` folders and is never edited by hand.
- **Root stays small.** A new root file needs a reason in its PR.

## Workspace names

| Folder | Package name |
| --- | --- |
| `packages/core` | `@ledgerly/core` |
| `packages/server` | `@ledgerly/server` |
| `apps/web` | `@ledgerly/web` |
| `functions/<name>` | `@ledgerly/fn-<name>` |

## Root scripts

| Script | Does |
| --- | --- |
| `npm run lint` | Biome check (lint + format check) |
| `npm run format` | Biome check, writing safe fixes (formatting, import order, safe lint fixes) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm test` | Vitest in every workspace |
| `npm run build` | Build web and bundle functions |
| `npm run dev` | Start the web app against the dev Appwrite project |
| `npm run appwrite:types` | Regenerate `packages/core/src/generated` (row types) from the schema |

These are created in task M0 "Monorepo tooling"; see the [roadmap](../planning/roadmap.md).
