# Writing docs

## Where docs live

- **`docs/` in the repo is the single source of truth.** GitBook shows the same files through Git Sync ([D-013](../architecture/decisions.md)).
- `docs/SUMMARY.md` is the GitBook table of contents. Add every new page to it.
- `AGENTS.md` at the repo root holds the short rules every coding agent loads automatically. It links into `docs/` for details instead of repeating them.

## When to update docs

In the **same PR** as the change, whenever you change:

- behaviour a user can see → `product/features.md` or `product/user-flows.md`
- a table, column or index → `architecture/data-model.md` (a `contract` PR)
- a function route or payload → `architecture/functions-api.md` (a `contract` PR)
- a money rule → `architecture/ledger.md`, plus the golden example test
- an architectural choice → a new entry in `architecture/decisions.md`
- how we work → `collaboration/` or `engineering/`

If code and docs disagree, the docs are right until a PR changes them. If you find a wrong doc, fix it in your PR and say so in the description.

## One fact, one place

Each fact is written down once. Other pages **link** to it instead of repeating it. Columns are only in `data-model.md`, routes only in `functions-api.md`, money rules only in `ledger.md`. Repeated facts drift apart, and then agents build different things.

## Style

- Plain English, short sentences. Write for someone smart who is new to the project, or whose first language isn't English.
- Lead with the answer, then the detail.
- Prefer tables and numbered steps over long paragraphs.
- Use exact names in backticks: `transactions.statementId`, `POST /transactions`.
- Diagrams are plain-text code blocks, so they render everywhere (GitHub, GitBook, terminals).
- Use the words from the [glossary](../product/glossary.md).
- Relative links between pages (`../architecture/ledger.md#invariants`), so they work on GitHub and in GitBook.

## GitBook

- Space: **Documentation** in the GitBook organization, published on the private (visitor-auth) site.
- Git Sync: repo `rojinc/ledgerly`, branch `main`, folder `docs/` (from `.gitbook.yaml`).
- Edit in the repo, not in the GitBook editor. If someone edits in GitBook, Git Sync turns it into a commit or PR. Review it like any other change.
