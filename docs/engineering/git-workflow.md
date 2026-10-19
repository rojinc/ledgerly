# Git workflow

## Branches

- `main` is always deployable. Nobody pushes to it directly; everything arrives through a pull request.
- One branch per issue: `<type>/<issue-number>-<short-slug>`

  | Example | For |
  | --- | --- |
  | `feat/17-ledger-function` | new behaviour |
  | `fix/42-shift-rounding` | bug fix |
  | `chore/3-ci-workflow` | tooling, config |
  | `docs/9-statement-layout` | docs only |
  | `contract/12-transaction-schema` | schema or API contract change |

- Keep your branch current by **rebasing** on `main` (`git pull --rebase origin main`). No merge commits inside branches.
- Never force-push a branch that isn't yours. Force-pushing your own branch with `--force-with-lease` is fine.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <what changed, in the imperative>

<optional body: why>

Refs #17
```

- **Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`.
- **Scopes:** `core`, `server`, `ledger`, `groups`, `identity`, `account`, `scheduler`, `statements`, `web`, `appwrite`, `infra`, `docs`.
- Example: `feat(core): add allocate() with largest-remainder rounding`.
- Small, focused commits. They are squashed on merge, but they help review.

## Pull requests

1. **One issue per PR.** The title is a conventional commit line; the body uses the template and says `Closes #<issue>`.
2. **Small:** aim for under 400 changed lines, not counting lockfiles and generated code. Split bigger work into stacked issues.
3. **Green CI:** lint, typecheck, tests and build must pass.
4. **Docs updated** in the same PR whenever behaviour, an API, the schema or a rule changes.
5. **Review:** at least one review. A different agent from the author reviews and posts comments. The **lead agent** reviews last and merges, following the merge rules in [Multi-agent workflow → Review](../collaboration/multi-agent-workflow.md#5-review); the merge is the approval. Agents often push with the owner's GitHub account, and GitHub doesn't let you approve your own PR, so no formal approval is required.
6. **Squash merge** only. The branch is deleted after merge.
7. Labels: one `area:*`, one `type:*`, `agent:*` (who wrote it), plus `contract` or `security` if they apply.

## Lockfile

- Only PRs that add, remove or upgrade dependencies change `package-lock.json`.
- If the lockfile conflicts during a rebase, take `main`'s version, then run `npm install` again on your branch.

## Releases

- Every merge to `main` deploys to the **dev** environment.
- A release is a git tag `vMAJOR.MINOR.PATCH` on `main`. Pushing the tag deploys to **prod**. Notes are generated from the conventional commits.
- Hotfix: branch from `main`, PR, merge, tag a patch release.

See [Environments and deploys](environments-and-deploys.md).

## Branch protection

The ruleset `protect-main` is active on `main`:

- a pull request is required (0 approvals, see Review above),
- review conversations must be resolved,
- linear history (squash merges only; merge and rebase merges are turned off in repo settings),
- no force pushes and no deletion.

Head branches are deleted automatically after merge. When the CI workflow (#2) lands, add its `ci` check to the ruleset as a required status check.
