# Multi-agent workflow

Several AI agents (Claude Code, Codex, others) and people work on this repo **at the same time**. This page is how we avoid duplicated work, conflicting changes and drifting designs. Every agent must follow it.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| **Owner** | Rojin (human) | Holds accounts, billing, secrets and console access. Has handed day-to-day decisions to the lead agent ([D-015](../architecture/decisions.md)). |
| **Lead agent** | one agent session at a time, named in [D-015](../architecture/decisions.md) | Sets priorities, writes and approves task specs, approves contract changes, makes design decisions (recorded in the decision log), reviews PRs and **merges every PR** |
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

**Sub-agents.** If your tool can start sub-agents, use them. One agent still owns each claim, branch and PR. Good uses:

- research or a scratch probe (for example checking how a library behaves) while you write code
- splitting your change into independent parts, each in its own worktree, which you then combine on your branch
- the self-review in step 4

Sub-agents never claim issues, push, post on GitHub (comments, labels or PRs), merge or touch Appwrite. The owning agent posts anything they found that others need, such as review findings. Give a sub-agent the issue's Scope and only what its job needs, never secrets, `.env` values or real personal data. You answer for everything it writes.

### 4. Finish

1. Rebase on `main`. Lint, typecheck, test and build must all pass locally.
2. Update the docs if behaviour, the contract or a rule changed.
3. **Self-review.** If you can start sub-agents, give a fresh one only the PR diff, the issue and these docs (not your reasoning). Ask it for blocking and optional findings, plus a [security pass](../architecture/security-and-privacy.md#security-review-rule) on `security` PRs. Fix the blocking ones, and say what it found under **How I tested it**. It cuts review rounds, but it isn't the [review](#5-review), except on the lead's own PRs.
4. Mark the PR ready using the template, with `Closes #<issue>`. Labels: `status:in-review` on the issue; `area:*`, `type:*` and `agent:*` on the PR.
5. Ask for review: comment `Ready for review` on the PR. If you can message other Claude Code sessions, also send the PR link to the lead agent's session; the lead also checks open PRs regularly. For other agents' PRs, the lead's own review counts as the review by a different agent.

### 5. Review

A reviewing agent checks, and comments with findings:

- Does it do what the issue's acceptance criteria say, no more and no less?
- Does it stay inside Scope?
- Do the ledger invariants, permission checks and money and date rules hold?
- Are the tests meaningful, including the failure paths?
- Are the docs updated?
- Is it as simple as it could be? Look for code to delete.

Any agent may review another agent's PR, and agents should when they are idle or the lead asks. Read the PR's existing comments first, so you don't repeat them. Before you start, comment `Reviewing`, and skip a PR another agent is already reviewing unless the lead asks. The reviewer **comments only**. Findings are marked **blocking** or **optional**. A blocking finding closes only when it is fixed or the reviewer agrees it doesn't apply. If the lead overrules one, the lead writes why on the PR. The author resolves a thread once it's fixed or the reviewer agrees; the lead resolves the ones it overrules.

The lead agent merges (squash) when all of these hold:

- a different agent has reviewed it and no blocking finding is open. A sub-agent the author started doesn't count, except on the lead's own PRs: there the reviewer can be a fresh agent (another agent's session, or a sub-agent set up like the self-review in step 4) that gets only the PR, the issue and these docs, not the lead's reasoning. The lead posts that reviewer's findings on the PR,
- CI is green on the latest commit. Until CI exists (#2), the lead runs lint, typecheck, test and build on the PR branch before merging,
- the acceptance criteria are met and the PR stays inside Scope,
- for `security` PRs, the review included a [security pass](../architecture/security-and-privacy.md#security-review-rule).

Only the lead agent merges. No other agent merges, not even its own PR.

### 6. Blocked or handing off

- Blocked: add `status:blocked` and comment with what's blocking and what you need.
- Can't finish: push your branch and comment with what's done, what's left and any traps. Then remove `agent:*` and set the status back to `ready`.

## Scope and parallel work

Every task issue lists **Scope**: the paths it may change. Two tasks can run in parallel when their scopes don't overlap. The repo layout is designed for this:

- Each function is its own folder (`functions/ledger/`, `functions/groups/` …).
- Each web feature is its own folder (`apps/web/src/features/shifts/` …).
- `packages/core` and `packages/server` are split into subfolders, and there are **no barrel files**, so two tasks never edit the same `index.ts`.
- Known shared files: `apps/web/src/routes.tsx` (one line per feature), `apps/web/src/lib/query-keys.ts` and `apps/web/src/lib/realtime.ts` (one line per query key), `package.json` / `package-lock.json` (only for dependency changes) and `docs/SUMMARY.md`. On conflicts there, keep both sides.

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

- Push to `main` or change branch protection. Merge a PR unless you are the lead agent.
- Edit Appwrite resources in the console, or push the schema from a laptop.
- Commit secrets, `.env` files or real personal data.
- Delete or skip tests to make CI pass.
- Reopen a [recorded decision](../architecture/decisions.md) in code. Propose a new decision instead.
- Work on an issue someone else has claimed.
- Add a dependency without justifying it in the PR.
