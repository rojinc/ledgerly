# Writing a task

A task is a GitHub issue that one agent can finish in one PR (ideally under a day of work, under 400 changed lines). A well-written task is the difference between an agent shipping the right thing and an agent guessing.

Use the **Task** issue template. Every section is required.

## Sections

| Section | What to write |
| --- | --- |
| **Goal** | One or two sentences: what exists after this task that didn't before, and why. |
| **Scope** | The exact paths this task may create or change. Used to check for overlaps with other tasks. |
| **Out of scope** | Nearby things this task must **not** do, usually because another issue covers them. |
| **Read first** | Links to the doc sections the agent needs. |
| **Acceptance criteria** | A checklist of observable results. Each item is testable. |
| **Depends on** | Issue numbers that must be closed first. |
| **Test plan** | What tests to add, and the commands that prove it works. |

## Rules for good tasks

- **One outcome.** If the goal has "and" in it, consider splitting it.
- **Scope by folder.** A task that touches three areas (core + function + web) is usually three tasks.
- **Contracts first.** If a task needs a new schema or API, make a separate `contract` task it depends on.
- **Acceptance criteria are checks, not wishes.** "`allocate(1000,[1,1,1])` returns `[334,333,333]`", not "rounding works well".
- **Link, don't repeat.** Point at the doc that defines the rule instead of copying it into the issue.

## Example

> **[M1] ledger function: create, update, void and post transactions**
>
> **Goal:** All transaction writes go through `functions/ledger`, which validates, authorizes and writes transaction + shares + items + activity atomically.
>
> **Scope:** `functions/ledger/**`
>
> **Out of scope:** timer and balances routes (#23); any web UI.
>
> **Read first:** [Functions API → ledger](../architecture/functions-api.md#ledger) · [The ledger](../architecture/ledger.md) · [Permissions → function-side checks](../architecture/permissions.md#function-side-checks)
>
> **Acceptance criteria**
> - [ ] `POST /transactions` creates the transaction, shares, items and activity in one TablesDB transaction
> - [ ] Same `id` + same body → 200 with the existing row; same `id` + different body → `CONFLICT`
> - [ ] `PATCH` rebuilds shares and items, and records before/after in activity
> - [ ] `void` deletes shares and keeps the row with `voidReason`
> - [ ] Locked transactions → `LOCKED`; viewers → `FORBIDDEN`; non-members → `NOT_A_MEMBER`
> - [ ] Every write calls `assertShareInvariants()` before committing
>
> **Depends on:** #14 (buildShares), #21 (groups function)
>
> **Test plan:** Handler tests with the fake database for each route: success, validation failure, auth failure, locked. `npm test -w @ledgerly/fn-ledger`.
