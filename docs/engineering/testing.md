# Testing

Money must be right. Tests focus on the places where a bug costs someone money or trust; everywhere else we test enough to change code safely.

## Where tests go

| Code | Test type | Tool | Expectation |
| --- | --- | --- | --- |
| `packages/core` money, ledger, settle, recurrence, dates | Unit + invariant tests | Vitest | **Every branch covered.** These are the rules of the product. |
| `packages/core` schemas | Unit | Vitest | Valid and invalid examples for each schema |
| `packages/server` | Unit with a fake Appwrite client | Vitest | Permission checks, error envelope, transaction helper |
| `functions/*` routes | Handler tests with a fake database | Vitest | Each route: happy path, auth failure, validation failure, locked |
| `apps/web` | Component tests for tricky logic only | Vitest + Testing Library | Forms that build payloads, calendar date maths |
| Whole flows (M2+) | End-to-end against the dev project | Playwright | Flows 1–5 in [user flows](../product/user-flows.md) |

Tests sit next to the code as `*.test.ts` (core, server, web) or in `test/` (functions).

## Invariant tests

Every function that produces shares or allocations gets an invariant test. It builds many random inputs and checks the [ledger invariants](../architecture/ledger.md#invariants) hold for all of them:

```ts
import { describe, expect, it } from 'vitest'
import { allocate } from './allocate'

describe('allocate', () => {
  it('always sums to the total and never differs by more than 1 cent from the exact share', () => {
    for (let run = 0; run < 2000; run++) {
      const total = Math.floor(Math.random() * 2_000_000) - 1_000_000
      const weights = Array.from({ length: 1 + Math.floor(Math.random() * 10) }, () => 1 + Math.floor(Math.random() * 100))
      const parts = allocate(total, weights)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      const sum = weights.reduce((a, b) => a + b, 0)
      parts.forEach((p, i) => expect(Math.abs(p - (total * weights[i]) / sum)).toBeLessThan(1))
    }
  })
})
```

A plain loop is enough; we don't need a property-testing library.

## Golden examples

`packages/core/src/ledger/examples.test.ts` holds the worked examples from [the ledger](../architecture/ledger.md#worked-examples) and [user flows](../product/user-flows.md), with exact expected cents. If a doc example changes, this test changes in the same PR, and the other way round.

## Rules

- A bug fix starts with a failing test that reproduces it.
- Never delete or skip a failing test to get CI green. If a test is wrong, fix it and explain why in the PR.
- No real network calls in unit tests. The fake Appwrite client lives in `packages/server/src/appwrite/fake.ts`.
- Tests must not depend on the machine's timezone. CI runs every test with `TZ=UTC` and again with `TZ=Australia/Sydney` to catch date bugs, and runs core's coverage gate in Sydney time.
- Keep tests fast: the whole unit suite should run in under 30 seconds.

## Commands

```bash
npm test                                  # everything
npm test -w @ledgerly/core                # one workspace
npm run coverage -w @ledgerly/core        # core with the 100% coverage gate (CI runs it with TZ=Australia/Sydney)
npx vitest run packages/core/src/money    # one folder
npm run test:e2e -w @ledgerly/web         # user flows 1–5 against dev (below)
```

## End to end

`apps/web/e2e/` runs [user flows](../product/user-flows.md) in Chromium with Playwright, against the **dev** project: flows 1–5. Flow 5 is skipped until the flows have a project of their own ([#386](https://github.com/rojinc/ledgerly/issues/386)): each run would leave a final invoice in dev, which is production, and a final statement is never changed or deleted (D-010). Flow 3's normal day, where the scheduler posts a shift once the day is over, isn't covered: it needs a day to pass. `npm test` never picks them up.

- **What runs:** `npm run test:e2e -w @ledgerly/web` starts a local Vite server, so the code under test is the checkout's (another server already on its port is an error, never reused), and points it at dev. The whole suite has 10 minutes. The browser is in `Australia/Sydney` (`timezoneId`) and `en-AU`, so a date that slips a day shows up.
- **What it needs:** `VITE_APPWRITE_ENDPOINT` and `VITE_APPWRITE_PROJECT_ID` for dev, and `E2E_APPWRITE_API_KEY`, a dev-only key with only `users.read` and `users.write` ([secrets](../architecture/security-and-privacy.md#secrets-inventory)). Without them, global setup stops with a message naming what's missing. Dev must also list `localhost` as a web platform, since the app is served from `localhost:5173`, in CI too: a console change to the production project, so the owner makes it with the key (#78).
- **Users:** global setup makes each run an ID (`e2e…`). It creates the users the flows log in as through the API, marked verified, because tests can't open an inbox. A user who signs up in the app is verified the same way. Teardown, which runs even if setup fails partway, deletes every user the run made: the server returns only addresses starting with the run's `delivered+<run ID>-`, so no one else's record is ever read. It deletes the users only, not the rows they made through the app: a person, a profile, identities, a personal group and its team each, and the flows' groups, schedules, transactions and activity (and, once flow 5 runs, its final invoice and PDF). Those stay in dev, which is production, after every run: `account POST /delete` refuses an account for 24 hours after its password is set, and the key can't reach the database. Nothing in them reaches a real person, as every address is a test one and the jobs skip a user that's gone.
- **Addresses:** every address is a Resend test address, `delivered+<run ID>-<label>@resend.dev`, billing emails included. No real inbox, and no real personal data. Names carry the run ID too, so rows a run leaves in dev are easy to spot.
- **Groups:** each flow that adds an employer archives it afterwards, even when the flow fails, so the statements job doesn't draft its invoices every month. Archiving stops its schedules too. It's refused while a timer is running or a statement is still finalizing, so a flow 3 that fails with its timer running, or a flow 5 whose finalize outlasts its wait, leaves its employer behind.
- **Email:** flow 5, once it runs, sends two through Resend, the invoice and the worker's copy, both to test addresses, which count against the project's Resend quota.
- **Waits:** Playwright's auto-waiting and `expect` polling only, never fixed sleeps. Flow 5 waits at most a minute for its invoice to be final.
- **Flow 5:** the statements job drafts a month's invoice only once the month is over, so the flow back-dates its entries into last month and drafts that month with `statements POST /statements/reissue`. It calls it in the page, through the app's own function client as the signed-in user, never with the key: the dev server serves the app's modules to import it from.
- **CI:** `.github/workflows/e2e.yml` runs after each successful deploy of `main` to dev (`workflow_run`) and on **Run workflow**, never on pull requests: a PR's code isn't deployed. Like Deploy, it tests only `main`'s latest commit, which is what dev runs. It uploads the Playwright report when a run fails. Until the key is set (#78), a run is skipped with a warning.
- **Locally:** put the three variables in the repo root's `.env.local`, the key too. Playwright reads that file, and Vite passes only the `VITE_` ones to the browser. Then run the command. `npx playwright install chromium` fetches the browser once.
