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
- Tests must not depend on the machine's timezone. CI runs with `TZ=UTC`, and core tests also run once with `TZ=Australia/Sydney` to catch date bugs.
- Keep tests fast: the whole unit suite should run in under 30 seconds.

## Commands

```bash
npm test                                  # everything
npm test -w @ledgerly/core                # one workspace
npx vitest run packages/core/src/money    # one folder
```
