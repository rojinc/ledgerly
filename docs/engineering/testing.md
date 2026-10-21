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
| Whole flows (M2+) | End-to-end against the dev project | Playwright | Flows 1–10 in [user flows](../product/user-flows.md), and the flows of features since ([#512](https://github.com/rojinc/ledgerly/issues/512)) |

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
- Tests must not depend on the machine's timezone. CI runs every test with `TZ=UTC`, and the function workspaces' and `@ledgerly/server`'s again with `TZ=Australia/Sydney` to catch date bugs, plus core's coverage gate in Sydney time. Run the rest (the web app) in Sydney time locally when you change date code.
- Keep tests fast: the whole unit suite should run in under 30 seconds.

## Commands

```bash
npm test                                  # everything
npm test -w @ledgerly/core                # one workspace
npm run coverage -w @ledgerly/core        # core with the 100% coverage gate (CI runs it with TZ=Australia/Sydney)
npx vitest run packages/core/src/money    # one folder
npm run test:e2e -w @ledgerly/web         # the e2e flows against dev (below)
```

## End to end

`apps/web/e2e/` runs [user flows](../product/user-flows.md) in Chromium with Playwright, against the **dev** project: flows 1–10 ([#526](https://github.com/rojinc/ledgerly/issues/526) added 6–10: a house bill split by days present, an itemised receipt with its photo, settle up and a finalized divide, a loan claimed by the person it was lent to, and weekly rent paused and resumed), then one flow each for the features shipped since ([#512](https://github.com/rojinc/ledgerly/issues/512)), named by feature: deleting an archived group, pausing and resuming a schedule, skipping a date, email settings, and deleting an account ([#525](https://github.com/rojinc/ledgerly/issues/525)). The last is refused while its user is a house's only admin and someone else there is `active`; once that housemate has moved out, it deletes the account, which archives the house, and the housemate deletes the house as its last person. Flow 5 finalizes an invoice, which never changes (D-010), but doesn't stay in dev, which is production: its employer never joined, so the run's worker's deletion purges the group with its statements and PDFs (Users, below; [#386](https://github.com/rojinc/ledgerly/issues/386)). Flow 8's final divide, and flow 7's receipt photo, go the same way: each house's other housemates are placeholders who never joined, so its maker's deletion purges it, files included ([purging a group](../architecture/identity-and-invites.md#purging-a-group)). Flow 3's normal day, where the scheduler posts a shift once the day is over, isn't covered: it needs a day to pass. `npm test` never picks them up.

- **What runs:** `npm run test:e2e -w @ledgerly/web` starts a local Vite server, so the code under test is the checkout's (another server already on its port is an error, never reused), and points it at dev. The whole suite has 10 minutes. The browser is in `Australia/Sydney` (`timezoneId`) and `en-AU`, so a date that slips a day shows up.
- **What it needs:** `VITE_APPWRITE_ENDPOINT` and `VITE_APPWRITE_PROJECT_ID` for dev, and `E2E_APPWRITE_API_KEY`, a dev-only key with only `users.read` and `users.write` ([secrets](../architecture/security-and-privacy.md#secrets-inventory)). Without them, global setup stops with a message naming what's missing. Dev must also list `localhost` as a web platform, since the app is served from `localhost:5173`, in CI too: a console change to the production project, so the owner makes it with the key (#78).
- **Users:** global setup makes each run an ID (`e2e…`). It creates the users the flows log in as through the API, marked verified, because tests can't open an inbox: each flow file has its own, so each starts from an empty dashboard. Flow 9 makes one more in the flow, the person the loan was for, only after the lender has added their address, so their first sign-in claims it. A user who signs up in the app is verified the same way. Teardown, which runs even if setup fails partway, labels every user the run made `e2e` and blocks it: the server returns only addresses starting with the run's `delivered+<run ID>-`, so no one else's record is ever read. The `account` hourly job then deletes each one as an account deletion does, within about two hours ([finishing purges](../architecture/identity-and-invites.md#finishing-purges), [#386](https://github.com/rojinc/ledgerly/issues/386)). That covers the rows they made through the app as well as the users: a person, a profile, identities, and a personal group and its team each, and the flows' groups (one two of them share goes with the second), schedules, transactions and activity, and, flow 5's final invoice and PDF. The key can't reach the database, and `account POST /delete` refuses an account for 24 hours after its password is set, so the job does it. The group delete is refused the same way ([refusals](../architecture/identity-and-invites.md#refusals)), so its flow checks that refusal with a password user, and deletes as a user made without a password ([#512](https://github.com/rojinc/ledgerly/issues/512)), as are the account-deletion flow's two, since `account POST /delete` is refused the same way ([#525](https://github.com/rojinc/ledgerly/issues/525)). These users sign in with a token the runner makes in Node (`POST /users/{id}/tokens`, which needs the e2e key, so only the runner can): only its user ID and secret reach the browser, which spends them at once on a session (`POST /account/sessions/token`), so a trace that shows them shows nothing usable. The key itself never reaches the page. Teardown checks every user setup made, the passwordless ones included: each is handed over, or gone, as the account-deletion flow's user is by the end of its run. One still live fails the run. A user teardown can't label and block, it deletes outright, as before, leaving that user's rows in dev, which is production, for the lead's one-off clean-up of past runs' rows (#386's Q3). Nothing in them reaches a real person, as every address is a test one and the jobs skip a user that's gone.
- **Addresses:** every address is a Resend test address, `delivered+<run ID>-<label>@resend.dev`, billing emails included. No real inbox, and no real personal data. Names carry the run ID too, so rows a run leaves in dev are easy to spot.
- **Groups:** each flow that adds an employer, a house or a lend & borrow archives it afterwards, even when the flow fails, so the statements job doesn't draft its invoices or divides every month. Archiving stops its schedules too. Archiving is refused while a timer is running or a statement is still finalizing, so a flow 3 that fails with its timer running leaves its employer behind. Flows 5 and 8 read their statement's status before archiving, and wait out a finalize that outlasts its minute, until 330 s after Finalize was clicked (the statements function's 300 s timeout, and a margin for a run that starts late), with that time added to the test's. A finalize stopped by a crash or a timeout stays `finalizing` until it's called again, so it still leaves the employer or house behind. A personal group can't be archived, so flow 10 stops its rent instead.
- **Email:** flow 5 sends two through Resend, the invoice and the worker's copy, both to test addresses, which count against the project's Resend quota. Flows 6–10 send none: flow 8 finalizes its divide without email. The account-deletion flow sends one invite, to its run's own test address ([#555](https://github.com/rojinc/ledgerly/issues/555)), and no flow sends a reminder. No flow types a phone number: flow 9 adds the person it lends to by email, not by mobile as the user flow does, since the app has no phone sign-up yet ([#40](https://github.com/rojinc/ledgerly/issues/40)), a phone identity on a run user would stop the `account` job deleting it, and a typed number could reach a real person.
- **Waits:** Playwright's auto-waiting and `expect` polling only, never fixed sleeps. Flows 5 and 8 wait at most a minute for their statement to be final (and their clean-up longer, above).
- **Time of day and cold starts** ([#406](https://github.com/rojinc/ledgerly/issues/406)): flow 3 checks its timed shift on the shift's own page, since Today's list moves to the next day at midnight. Flow 5 works out last month before it makes its group, so a month's end in between can't make that month the group's first, which reissue refuses. The balances query doesn't retry, so flows 4, 8 and 9 reload the page once if a call that failed on a cold start after a deploy leaves the balance unavailable ("Balance not available right now.", "We couldn’t load the balances." or "Not available yet", as each page words it), and print a warning, so a reload that happens on every run shows on green runs too.
- **Flow 5:** the statements job drafts a month's invoice only once the month is over, so the flow back-dates its entries into last month and drafts that month with `statements POST /statements/reissue`. It calls it in the page, through the app's own function client as the signed-in user, never with the key: the dev server serves the app's modules to import it from.
- **CI:** `.github/workflows/e2e.yml` runs after each successful deploy of `main` to dev (`workflow_run`) and on **Run workflow**, never on pull requests: a PR's code isn't deployed. Like Deploy, it tests only `main`'s latest commit, which is what dev runs. It uploads the Playwright report when a run fails. Until the key is set (#78), a run is skipped with a warning.
- **Locally:** put the three variables in the repo root's `.env.local`, the key too. Playwright reads that file, and Vite passes only the `VITE_` ones to the browser. Then run the command. `npx playwright install chromium` fetches the browser once.

### Coverage

Every v1 behaviour in [features](../product/features.md), and the spec that drives it end to end, or the unit tests that cover it and why e2e can't ([#555](https://github.com/rojinc/ledgerly/issues/555)). No spec reads an inbox, so an email is checked by the app saying it went, and its contents by unit tests. **Where they run:** every step runs on dev. Steps that need file storage, a PDF or sign-up are marked *dev-only*: all of `flow-1` (sign-up) and `flow-5` (its PDF), and `flow-7` from its receipt photo on. The rest also run on a local mock of the functions ([#554](https://github.com/rojinc/ledgerly/issues/554)). Rows marked *to come* are #555's later PRs.

| Feature | Driven by | Or unit tests, and why |
| --- | --- | --- |
| F-01 sign up, log in by password | `flow-1` (*dev-only*), every flow's `logIn` | |
| F-01 email code, set and change a password; change of email, Sign out other devices | *to come* | |
| F-01 reset by an emailed link | | `recover-page`, `recover-complete-page`, `login-page`: the secret only comes by email |
| F-02 verify, then claim | `flow-1` (*dev-only*; verified through the API) | Invites need it: `invite-member`, `identity/test/invites` |
| F-03 profile | `email-settings`: region, currency, reload | |
| F-04 business details on an invoice | *to come* | |
| F-06 delete account; export your data | `account-delete`: deletion, then `profile.csv` and `my-records.csv` | |
| F-07 the getting-started guide | `flow-1` (*dev-only*), `flow-2`; step 2 *to come* | Hide: `getting-started` |
| F-10 create each group type | `flow-2`, `flow-6`, `flow-9` | |
| F-11 add by email; a per-group name | `account-delete`, `flow-9`; the rename *to come* | By phone and roles: `groups/test/add-member`, `update-member`: no flow types a number |
| F-12 not joined | `flow-9` (unregistered), `account-delete` (registered) | |
| F-13 moving in and out | `flow-6`, `account-delete` | |
| F-14 activity | `flow-3` | |
| F-15 archive, unarchive, delete | `group-delete`, `account-delete` | |
| F-20–F-28 employer, shifts, schedules, timer, expenses, payments, balance | `flow-2`, `flow-3`, `flow-4`, `skip-dates`, `schedule-pause`; start and end with a break, *to come* | Auto-confirm and the 12 h reminder: `scheduler/test/auto-post`, `reminders`, since a day must pass |
| F-29 invoices: draft, finalize, send, number, PDF | `flow-5` (*dev-only*); void and reissue *to come* | Close period now (the house's is `flow-8`): `close`, `statements`; auto-finalize and auto-send: `auto-send`, timed |
| F-30 a rate change affects the future only | *to come* | |
| F-40 housemates; invite by email | `flow-6`, `account-delete` | Accepting: `invite-page`, `accept-invite` |
| F-41–F-48 house expenses, bills, items, receipts, recurring, settle up, divide, locks | `flow-6`, `flow-7` (*dev-only* from its photo on), `flow-8`; split modes, recurring, the divide's contents and PDF *to come* | Who may add and edit: `transactions`, `transactions-update`; a PDF receipt: `receipts-section` |
| F-50, F-51 personal bills | `flow-10` | Reminders before due (F-52): `scheduler/test/bills`, timed |
| F-53, F-54 spending and income | *to come* | |
| F-60–F-63 lend and borrow | `flow-9`, `flow-1` (*dev-only*); partial repay and a reminder *to come* | The reminder email: `identity/test/reminders` |
| F-70 calendar | `flow-2`, `flow-3` | Colours: `calendar-page` |
| F-71 history filters and search | *to come* | |
| F-72 CSV export | *to come* | |
| F-80 summary email | `email-settings`: the frequency stays | The email: `scheduler/test/summaries`, timed |
| F-81 notifications | `email-settings`; "added to a group" in `flow-1` (*dev-only*), `flow-9` | The emails: `draft-reissue`, `bills`, `reminders`, `transaction-changes`, `pending-groups` |
| F-82 work-hours cap | *to come* | |
