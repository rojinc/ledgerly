# Multi-agent workflow

Several AI agents (Claude Code, Codex, others) and people work on this repo **at the same time**. This page is how we avoid duplicated work, conflicting changes and drifting designs. Every agent must follow it.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| **Owner** | Rojin (human) | Holds accounts, billing, secrets and console access. Has handed day-to-day decisions to the lead agent ([D-015](../architecture/decisions.md)). |
| **Lead agent** | one agent session at a time (now: the Claude Code session that runs Agent 1) | Sets priorities, writes and approves task specs, approves contract changes, makes design decisions (recorded in the decision log), reviews PRs and **merges every PR** |
| **Implementing agent** | Claude Code, Codex, … | Picks one ready task, implements it on its own branch and worktree, opens a PR, responds to review |
| **Reviewing agent** | a *different* agent from the author | Reviews a PR against its issue and these docs, and comments |

## Sources of truth

| What | Where |
| --- | --- |
| What we're building and how | `docs/` (this site) |
| What to do next | GitHub **Issues**, grouped into **milestones** M0–M5 |
| Who is doing what | Issue **labels** (`status:*`, `agent:*`) and the claim comment |
| Decisions and discussion | Issue and PR comments, never private chats, so every agent can see them |
| The order of milestones | [Roadmap](../planning/roadmap.md) |

## Labels

| Group | Labels |
| --- | --- |
| Status | `status:needs-spec`, `status:ready`, `status:in-progress`, `status:in-review`, `status:blocked` |
| Agent | `agent:claude`, `agent:codex`, `agent:human` |
| Area | `area:core`, `area:server`, `area:functions`, `area:web`, `area:appwrite`, `area:infra`, `area:docs` |
| Type | `type:feature`, `type:bug`, `type:chore`, `type:docs`, `type:spike` |
| Special | `contract` (schema/API change), `security`, `decision`, `good-first-task` |

## Task lifecycle

```
needs-spec ──(lead approves spec)──► ready ──(agent claims)──► in-progress ──(PR opened)──► in-review ──(lead merges)──► closed
                                         ▲                          │
                                         └──── blocked ◄────────────┘ (with a comment saying why)
```

### 1. Pick a task

Only pick an issue that:

- is labelled `status:ready`,
- has every issue in its **Depends on** list closed,
- has no `status:in-progress` issue whose **Scope** overlaps with its own (see below).

Take tasks in milestone order, lowest issue number first, unless the lead agent says otherwise.

### 2. Claim it

1. Add the labels `status:in-progress` and `agent:<you>`, and remove `status:ready`.
2. Post a comment:
   ```
   Claimed by <agent name> · branch feat/17-ledger-function · started <date>
   ```
3. If two agents claim at the same moment, the **earlier comment wins**. The other un-claims and picks something else.

A claim with no activity (commits, comments or a PR) for **48 hours** may be released by the lead agent.

### 3. Work

- Make a branch and **your own worktree** ([local setup](../engineering/local-setup.md#working-as-an-agent)). Never share a working directory with another agent.
- Read `AGENTS.md`, then the docs listed in the issue's **Read first** section, before writing code.
- **Stay inside the issue's Scope paths.** If you need to change a file outside your scope:
  - small and obviously safe (a one-line route registration in `apps/web/src/routes.tsx`): go ahead and mention it in the PR;
  - anything else: stop, comment on the issue explaining what you need and why, and wait for the lead agent. Or open a new issue for it.
- Follow [conventions](../engineering/conventions.md) and [testing](../engineering/testing.md).
- Push early, and open a **draft PR** once you have something, so others can see your direction.

### 4. Finish

1. Rebase on `main`. Lint, typecheck, test and build must all pass locally.
2. Update the docs if behaviour, the contract or a rule changed.
3. Mark the PR ready using the template, with `Closes #<issue>`. Labels: `status:in-review` on the issue; `area:*`, `type:*` and `agent:*` on the PR.
4. Ask for review: comment `Ready for review` on the PR. If you can message other Claude Code sessions, also send the PR link to the lead agent's session; the lead also sweeps open PRs regularly.

### 5. Review

A reviewing agent checks, and comments with findings:

- Does it do what the issue's acceptance criteria say, no more and no less?
- Does it stay inside Scope?
- Do the ledger invariants, permission checks and money and date rules hold?
- Are the tests meaningful, including the failure paths?
- Are the docs updated?
- Is it as simple as it could be? Look for code to delete.

The reviewer **comments only**. Findings are marked **blocking** or **optional**.

The lead agent merges (squash) when all of these hold:

- a different agent has reviewed it (for the lead's own PRs: another lane agent, or a separate reviewer sub-agent) and no blocking finding is open,
- CI is green on the latest commit (once CI exists, #2),
- the acceptance criteria are met and the PR stays inside Scope,
- for `security` PRs, the review included a security pass (permissions, identity, secrets, file access).

Implementing agents never merge, including their own PRs.

### 6. Blocked or handing off

- Blocked: add `status:blocked` and comment with what's blocking and what you need.
- Can't finish: push your branch and comment with what's done, what's left and any traps. Then remove `agent:*` and set the status back to `ready`.

## Scope and parallel work

Every task issue lists **Scope**: the paths it may change. Two tasks can run in parallel when their scopes don't overlap. The repo layout is designed for this:

- Each function is its own folder (`functions/ledger/`, `functions/groups/` …).
- Each web feature is its own folder (`apps/web/src/features/shifts/` …).
- `packages/core` and `packages/server` are split into subfolders, and there are **no barrel files**, so two tasks never edit the same `index.ts`.
- Known shared files: `apps/web/src/routes.tsx` (one line per feature), `package.json` / `package-lock.json` (only for dependency changes) and `docs/SUMMARY.md`. On conflicts there, keep both sides.

## Contract changes

A **contract** is anything other tasks build on:

- `docs/architecture/data-model.md` and `appwrite/*.json`
- `docs/architecture/functions-api.md` and `packages/core/src/schemas/**`
- `docs/architecture/ledger.md` rules and `packages/core/src/ledger/**` exports
- `packages/core/src/constants/**`

Rules:

1. Contract changes go in their **own PR** labelled `contract`, separate from feature code where possible.
2. The lead agent must approve them.
3. They merge **before** the tasks that depend on them start, so everyone builds on the same contract.
4. If you discover mid-task that the contract is wrong, stop and comment on the issue. Don't quietly change it inside a feature PR.

## Tool setup

| Agent | Reads automatically | Notes |
| --- | --- | --- |
| Claude Code | `CLAUDE.md`, which imports `AGENTS.md` | Use plan mode for tasks bigger than a few files |
| Codex | `AGENTS.md` | Run in a separate worktree or cloud sandbox per task |
| Others | point them at `AGENTS.md` first | none |

All agents get the same rules from `AGENTS.md`. Don't put rules only in a tool-specific file.

## What agents must never do

- Push to `main`, merge PRs, or change branch protection.
- Edit Appwrite resources in the console, or push the schema from a laptop.
- Commit secrets, `.env` files or real personal data.
- Delete or skip tests to make CI pass.
- Reopen a [recorded decision](../architecture/decisions.md) in code. Propose a new decision instead.
- Work on an issue someone else has claimed.
- Add a dependency without justifying it in the PR.
