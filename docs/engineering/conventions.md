# Code conventions

These rules keep code written by different people and agents looking like one codebase. Biome enforces formatting; this page covers what a linter can't.

## Simplicity first

- Write the **smallest change** that meets the acceptance criteria. No "for later" code, no options nobody asked for, no abstraction with one implementation.
- Before writing code, check whether it already exists in `packages/core`, `packages/server` or the web app's `lib/`. Reuse beats re-implementing.
- Prefer the platform: the standard library, native HTML elements (`<input type="date">`), CSS over JavaScript, database constraints over app checks.
- If you deliberately take a shortcut with a known limit, leave a comment that says so and names the upgrade path:
  `// simple: sums on read; add balances table when /balances p95 > 500ms (scaling.md)`.

## TypeScript

- `strict: true`, ES modules, `target: ES2022`.
- No `any`. Use `unknown` and narrow with zod.
- Types come from zod schemas (`z.infer`) or generated row types. Never hand-write a second copy of a payload type.
- Use named exports only. No default exports, except where a tool requires one (Appwrite function entry, Vite config).

## Naming

| Thing | Style | Example |
| --- | --- | --- |
| Files and folders | kebab-case | `build-shares.ts`, `features/shifts/` |
| React components | PascalCase export in a kebab-case file | `shift-editor.tsx` exports `ShiftEditor` |
| Functions, variables | camelCase | `suggestTransfers` |
| Types | PascalCase | `TransactionInput` |
| Constants | UPPER_SNAKE | `MAX_ITEMS_PER_TRANSACTION` |
| Money variables | end in `Cents` | `totalCents`, `rateCents` |
| Local dates | `LocalDate` type, names end in `On` or are `date` | `dueOn`, `joinedOn` |
| Instants | ISO strings, names end in `At` | `startedAt` |
| Table IDs, columns | as in [data model](../architecture/data-model.md) | `transactions.receiptFileIds` |

Use the words from the [glossary](../product/glossary.md), in code and in UI text.

## Money

- Integer cents, always. Never `parseFloat` a money string; use `parseMoney()` from core.
- Format only at the edge: `formatMoney(cents, currency)` uses `Intl.NumberFormat`.
- Splitting an amount always goes through `allocate()`. Never divide money with `/` in feature code.

## Dates and time

- A calendar date is a `LocalDate` string. **Never** `new Date('2026-10-29')`: it parses as UTC midnight and shifts the day in Australia.
- Use the core helpers in `packages/core/src/dates`: `localToday(timeZone, now)`, `addDays(date, n)`, `compareDates(a, b)`, `daysBetween(a, b)`, `overlapDays(a, b)`, `periodFor(...)`, `closeAtFor(...)`.
- Pure functions take `now` as a parameter. Only entry points (handlers, React components) read the clock.

## Validation and errors

- Validate every function input with its zod schema at the start of the handler.
- Throw `AppError(code, message, details?)` from `packages/server/http`. Codes are listed in [Functions API](../architecture/functions-api.md#response-envelope). Never invent a new code without adding it there.
- Never swallow errors. If you catch, either handle it fully or rethrow with context.
- In the web app, show errors next to the action that failed, in plain language, with what to do next.

## Functions

- One route per file in `src/routes/`. Each file exports its zod schema and handler.
- Every write goes through `withTransaction()` from `packages/server`, even a single row, so all writes share one path (and one fake in tests). Bulk jobs over 90 writes use `writeInBatches()`.
- `await tx.write(...)` stages its writes at once. To guard a row, for example never to change a locked transaction (I-7): stage the write to that row first, then read it with `transactionId: tx.id` and check it. A change by anyone else after the write was staged makes the commit fail with 409; a change before staging doesn't, so never check first and stage later.
- `requireMember()` reads outside the transaction: it authorizes the request as it starts. If a route depends on a row staying as it was until the commit, guard that row with the pattern above.
- Declare routes with `route(method, '/path/:id', handler)`: `ctx.params` is typed from the path.
- Handlers are thin: validate → authorize → call core → write → respond. Business rules live in `packages/core`.
- Log one structured line per request: `{ fn, route, status, ms, code?, cause? }`, where `cause` is the name (never the message) of the error behind a 5xx. `createHandler` does this. No personal data ([security](../architecture/security-and-privacy.md)).
- Send email only with `sendEmail()` (`packages/server/src/email/`), with the subject and body from a template there. It logs nothing. Its `EmailError` carries only a `type` and an HTTP `status`, which are safe to log. Never log an address, subject or body. Where a send may run again after a crash, like finalize step 8, pass an `idempotencyKey` such as `finalize/<statementId>`, so Resend delivers it once (keys last 24 hours).

## React

- Function components and hooks only.
- Server data is fetched with TanStack Query. Query keys come from `lib/query-keys.ts`. Don't copy server data into `useState`.
- Writes use `useMutation` with optimistic updates where the result is predictable.
- Forms use react-hook-form + the **same zod schema** as the function.
- Accessibility basics are required: every input has a label, everything works by keyboard, focus is visible, and colour is never the only signal (dashed vs solid on the calendar, not just colour).
- Mobile first: build at 375 px wide, then check desktop.

## Dependencies

Before adding a package, check in this order:

1. Do we need this at all?
2. Is it already in the repo?
3. Does the standard library or the platform do it?
4. Is an existing dependency enough?
5. Can it be a few lines of our own code?

If you still need it, add it and write one line in the PR description: what it is, why, and roughly how big it is. The approved list is in [Tech stack](../architecture/tech-stack.md).

## Comments

- Explain **why**, not what. The code says what.
- Link to the doc that defines a rule: `// I-4: signs never mix (ledger.md#invariants)`.
- No commented-out code. Git remembers.
