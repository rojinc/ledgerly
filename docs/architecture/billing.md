# Billing

How Ledgerly would charge for itself ([#55](https://github.com/rojinc/ledgerly/issues/55)). This is a **design on paper**: nothing here is built, and no Stripe account or key exists. The decision is [D-019](decisions.md#d-019-free-at-launch-one-paid-plan-later-pulled-from-stripe) (proposed). Prices, tax and whether to charge at all are the owner's ([D-015](decisions.md#d-015-the-lead-agent-runs-the-project-day-to-day)); they are listed under [owner questions](#owner-and-legal-questions) and not answered here.

Charging our own users for the app is not moving their money. [D-014](decisions.md#d-014-we-record-money-we-dont-move-it) still holds: users settle with each other outside the app, and Stripe only ever takes a payment for Ledgerly itself.

## Recommendation

**Launch free (option a). When the owner decides to charge, build option b as designed below: one paid plan through Stripe Checkout and the Customer Portal, with the subscription state pulled from Stripe, so no function needs a public URL.**

Why:

- **Simple first** ([principle 6](../product/vision.md#principles)). The launch measures are use, not revenue: the founder invoicing for two months, a house closing a month in under five minutes. Billing adds a function, a table, a new error and owner setup (an account, terms, refunds, tax) before any of that is known.
- **Shared groups grow by invitation.** A paywall at launch slows down exactly the houses and pairs that bring new people.
- **The costs that grow with use are already capped.** Appwrite Pro and Resend are flat at launch size. SMS is the only real per-use cost, and invites and reminders are rate limited per sender ([security](security-and-privacy.md#threats-and-controls)).
- **The design is ready when it's needed.** Settling it now means a later "charge from next month" is a list of known tasks, not a new spike.

This settles the docs: billing is **decided** for the [M4 exit](../planning/roadmap.md) (free at launch, this design for later), and it stays under **Later** in [features](../product/features.md#later-not-v1).

### When to switch on option b

Any one of these, decided by the owner: they choose to charge; running costs pass a monthly amount they set; or SMS spend needs a payer.

## Options compared

| | (a) Free at launch | (b) Free + one paid plan | (c) Usage-based, SMS only |
| --- | --- | --- | --- |
| **What the user sees** | Everything, free. | Everything free except a few writes (the [gate table](#what-a-plan-gates)). A Plan section on Profile: Upgrade opens Stripe Checkout; Manage opens the Stripe Portal. | Everything free; sending an SMS needs prepaid credit or a card on file. |
| **Build work** | None. | 9 tasks ([follow-ups](#follow-up-tasks)): contract, core, server, three function, web, owner setup and docs. | About the same as (b), plus metering or credits, usage records and a balance screen. |
| **Running cost** | Appwrite, Resend and SMS, paid by the owner with no revenue. | The same, less subscription income; Stripe's per-charge fee on each payment. | The same; Stripe's fixed per-charge fee is large next to a few cents of SMS, so it needs bundled credits. |
| **Risks** | Costs grow with no income; adding a paywall later to people used to free (owner question: [grandfathering](#owner-and-legal-questions)). | Tax, terms and refunds must be ready first; failed payments and support; a gate in the wrong place blocks a shared group. | The most build work for the least revenue; small charges confuse people; SMS isn't built yet ([#40](https://github.com/rojinc/ledgerly/issues/40)). |

Option c is not recommended. If SMS needs a payer, gate it in option b (the table below does).

## What a plan gates

Two plans: **Free** and **Pro**. The rules:

1. **Only writes are gated, never reads.** Seeing groups, balances, history, statements, PDFs and exports is always free. Downloading your data is never paid for.
2. **Viewers, placeholders and invitees never pay or meet a gate.** Viewers can't make these writes anyway; placeholders and people who never sign up make no writes at all ([D-016](decisions.md#d-016-being-added-to-a-group-doesnt-make-you-a-member-you-join)). Accepting an invite, claiming and joining are never gated.
3. **The payer is the account making the gated write,** never the other members of its groups. A house's free members aren't affected by one member's plan.
4. **A downgrade deletes nothing and changes no closed period.** Groups, schedules, statements and PDFs stay as they are, and final statements never change ([D-010](decisions.md#d-010-closed-periods-never-change)). Only new gated writes are refused. Anything already set up keeps working: a second employer group made on Pro still takes shifts, and its schedules still run.
5. **Scheduled jobs are never gated.** They write as the system with no caller ([permissions](permissions.md#function-side-checks)), so there is no payer. `autoFinalize` doesn't send ([statements](statements.md)), so no job emails on a user's behalf.

The proposed gates. They target the gig worker, who bills for work, and the actions that cost us per use. The owner may move rows; the rules above don't change.

| Gated write (Pro) | Route that refuses it | Free allows |
| --- | --- | --- |
| A second (or later) employer group | `groups POST /groups` with `type: 'employer'` | One employer group that the caller owns (`ownerPersonId`) and that isn't archived |
| Emailing an invoice | `statements POST /statements/{id}/finalize` with `send: true`, and `POST /statements/{id}/send`, only for a statement with `type: 'invoice'` | Emailing a house's `divide`, on either route. Finalizing an invoice without sending, and downloading the PDF to send yourself. A statement left `finalizing` can always be finished with `send: false`, so a downgrade never leaves a period blocked |
| An SMS invite, once [#40](https://github.com/rojinc/ledgerly/issues/40) ships | `identity POST /invites` with `phone` | Email invites |
| An SMS reminder, once SMS reminders ship | `identity POST /reminders` with a future `channel: 'sms'` | Email reminders |

**The refusal.** A new error code, proposed for the [functions API list](functions-api.md#response-envelope) in the contract task:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `PLAN_REQUIRED` | 402 | The caller's plan doesn't include this write. `details: { feature }` names the gate (`employerGroups`, `invoiceEmail`, `smsInvite`, `smsReminder`). |

The plan check runs **after** the route's own checks ([function-side checks](permissions.md#function-side-checks); `POST /groups` skips steps 2–5), after the body is validated, and after a same-ID replay is answered ([idempotency](functions-api.md#idempotency)), so a retried create gets its stored row, never `PLAN_REQUIRED`. So someone who isn't a member still gets `NOT_A_MEMBER`, and a bad body still gets `VALIDATION_FAILED`. The answer is only ever about the caller's own plan, so it shows nothing about anyone else. `finalize` is called async, so the app sees only the HTTP status there: it reads 402 as `invoiceEmail`.

## How Stripe plugs in

### Checkout and the Portal

Stripe hosts both pages, so no card data ever reaches the app or our functions. The client only opens a URL that a function returns ([D-003](decisions.md#d-003-clients-never-write-to-the-database)).

A new function, **`billing`**, with execute `users` like every other function:

| Route | Body | Returns | Who |
| --- | --- | --- | --- |
| `POST /checkout` | `{ id }` (the client's `ID.unique()`, for the Stripe idempotency key) | `{ url }` | the user; `CONFLICT` while they have a live subscription (step 1 below) |
| `POST /portal` | none | `{ url }` | the user; `NOT_FOUND` if they have no Stripe customer |
| `POST /sync` | none | `{ plan, status, currentPeriodEnd }` | the user; a sync under 10 seconds old is returned as stored, without calling Stripe |
| hourly cron | | | scheduled only ([below](#late-changes-and-stripe-being-down)) |

`POST /checkout`:

1. Read the caller's `subscriptions` row. If it has a `stripeCustomerId`, sync it first, as `POST /sync` does. Then refuse with `CONFLICT` unless its `status` is `none`, `canceled` or `incomplete_expired`. Any other status (`trialing`, `active`, `past_due`, `unpaid`, `incomplete` or `paused`) is a live subscription, managed in the Portal, and the app shows Manage instead of Upgrade for it. Refusing only when the user is Pro isn't enough: a `past_due` user is Free once the grace ends, and a second Checkout would open a second subscription, so they'd pay twice once Stripe's retry of the first invoice succeeds. The sync stops a stale row (a paid Checkout whose return never synced) from letting a second one through.
2. If the row has no `stripeCustomerId`, stage a guard write on it (a fresh `rev`), create the Stripe customer with the idempotency key `customer-<personId>` and only `metadata.personId`, then commit the ID. A parallel call with the same key while the first is still running gets Stripe's `idempotency_error` (409), which answers `CONFLICT` (try again); a later one gets the same customer. Stripe keeps keys for at least 24 hours, so a crash between Stripe's answer and the commit, retried after that, can leave an unused customer behind: harmless, as it has no subscription.
3. Create a Checkout Session: `mode: subscription`, the one price, `customer`, `client_reference_id: personId`, and return URLs on `APP_URL` (`/profile?billing=done` and `/profile?billing=cancelled`). The Stripe idempotency key is `checkout-<id>`.

We send Stripe a person ID and nothing else. Checkout asks for the email it sends receipts to.

`POST /portal` makes a Billing Portal session for the stored customer, returning to `/profile`. The Portal is set up (owner task) to cancel **at period end** only, with one plan, so it can't make a state the design doesn't expect.

### The webhook question: pull, don't push

Every function is execute `users` only, never `any` or `guests`, so no function has a public URL ([permissions](permissions.md#function-execute-permissions)). Stripe signs its webhooks but doesn't sign in, so a webhook needs a way around that rule. Three designs:

| Design | Security rule change | Verdict |
| --- | --- | --- |
| **Pull on demand** (no webhook) | **None.** | **Chosen.** One plan with cancel-at-period-end changes state at known times, so pulling then is enough. |
| A webhook function with execute `any` and a signature check | Yes ([below](#if-the-lead-picks-the-webhook-instead)) | The fallback, if the lag of pulling turns out to matter. |
| A relay outside Appwrite that checks the signature and calls a function | None in Appwrite, but a new host to run and secure, holding a key that can execute functions | Not recommended: more to run than either of the others. |

**Pull on demand.** `billing` reads the customer's subscriptions from Stripe (`GET /v1/subscriptions?customer=…&status=all`) and stores the current one: an `active`, `trialing` or `past_due` one first, then the one with the latest period end. Each subscription's period end is read from its item (`items.data[0].current_period_end`), where the pinned API version keeps it. This "sync" runs:

- when the app comes back from Checkout or the Portal (`POST /sync`);
- when a `PLAN_REQUIRED` refusal offers "Refresh my plan" (`POST /sync`, then the user retries), for someone who paid and closed the tab before the return;
- hourly, for every `past_due` row, and every `active` or `trialing` row whose `currentPeriodEnd` has passed (renewals, failed renewals and cancellations at period end all happen then).

Because a sync stores Stripe's **current** state, the order of calls doesn't matter, and two syncs at once both write a correct state. It writes in one TablesDB transaction with a fresh `rev`, and skips the write if nothing changed.

#### If the lead picks the webhook instead

The exact rule changes:

- **[permissions.md → function execute permissions](permissions.md#function-execute-permissions):** "execute is `users` only, never `any` or `guests`" gains one exception: a new function, `stripe-webhook`, with execute `any`. Its generated domain is then public. It has one route (`POST /`), reads no caller and no JWT, has no other route that a public URL could reach, and its key scopes are `rows.read` and `rows.write` only.
- **[security-and-privacy.md → threats](security-and-privacy.md#threats-and-controls):** the "pretends to be another user" row changes from "functions are `users`-only" to "functions are `users`-only except `stripe-webhook`, which trusts only a valid Stripe signature".

What it must do:

- **Check the `Stripe-Signature` header before parsing anything:** HMAC-SHA256 of `<timestamp>.<raw body>` with `STRIPE_WEBHOOK_SECRET`, compared in constant time (`node:crypto` `timingSafeEqual`) against each `v1=` value in the header (there are two while a secret is being rolled), with a 5-minute timestamp tolerance. Anything else gets 400 and is logged by code only. The raw body must be exactly the bytes Stripe sent; that must be proven on `ledgerly-dev` before building, since a re-encoded body fails every check.
- **Handle each event once, by event ID.** A `stripeEvents` row whose ID is the first 32 hex characters of SHA-256 of the event ID (Appwrite IDs are 36 characters at most; Stripe's can be longer), written in the same transaction as the change. A redelivery finds the row and answers 200.
- **Never trust the event's payload for state.** On any `customer.subscription.*` event, run the same sync as above. Late or out-of-order events then can't roll the state back.
- **Cost:** a public URL can be called by anyone, and every call is an execution we pay for. It needs an Appwrite firewall rate limit.

### The subscriptions table

Proposed for the contract task. One row per person who has started Checkout; row ID = `personId`, so the plan check is one `getRow`.

| Column | Type | Notes |
| --- | --- | --- |
| `stripeCustomerId` | varchar(255)? | Stripe's `cus_…` ID; empty only while the first Checkout is creating it. With the subscription ID, the only Stripe identifiers we keep about a person. |
| `stripeSubscriptionId` | varchar(255)? | The current subscription, if any |
| `status` | enum(none, trialing, active, past_due, canceled, unpaid, incomplete, incomplete_expired, paused) | Stripe's status, as last synced; `none` before the first Checkout |
| `currentPeriodEnd` | datetime? | |
| `pastDueSince` | datetime? | When a sync first saw `past_due`; cleared by any other status |
| `cancelAtPeriodEnd` | boolean | Default `false`; shown on Profile |
| `syncedAt` | datetime | |
| `rev` | varchar(20)? | A fresh value on every guard write ([ledger concurrency](ledger.md#concurrency)) |

Index: `idx_status_periodEnd (status, currentPeriodEnd)` for the hourly sync.
Permissions: `read("user:<userId>")`, like `profiles`, so the app shows the user's own plan without a route. Only `billing` writes it, and `account` deletes it. Table-level permissions stay empty.

A person who is merged away is always a placeholder, and placeholders can't sign in to pay, so a row never needs to move in a [merge](identity-and-invites.md#merging-two-persons).

### The plan check

The rules live in `packages/core/src/billing/` as pure functions with full branch coverage:

- `planOf(row, now)`: **Pro** when `status` is `active` or `trialing` and `now` is before `currentPeriodEnd` plus a 3-day grace, or `status` is `past_due` and `now` is before `pastDueSince` plus the same grace; otherwise **Free**. No row is Free. (Stripe moves the period on even when a renewal fails, so `currentPeriodEnd` alone would give a whole unpaid period.)
- `GATES`: each gate's `feature` name and its Free allowance (the table above).

`packages/server` gets `requirePlan(services, personId, feature)`: one `getRow` on `subscriptions` (a missing row is Free), then `planOf`; it throws `PLAN_REQUIRED`. The gated routes call it after their other checks. The employer-group count is the one gate needing more: only when the plan is Free, it counts the caller's non-archived employer groups by `ownerPersonId`, leaving out the group being created, and stages a guard write on the caller's `persons` row (a fresh `rev`, as invite limits do), so two creates at once can't both count 0.

The web app uses the same `planOf` on the row it reads, to show the plan and hide or label gated buttons. The function check is the one that counts.

### Late changes and Stripe being down

- **Gates never call Stripe.** They read only the stored row, so a Stripe outage never blocks a write a Pro user is allowed.
- **A renewal** is picked up by the hourly sync after `currentPeriodEnd`; the 3-day grace covers that hour. **A failed renewal** gives 3 days from `pastDueSince`, while Stripe retries the card (for up to about two weeks by default); `past_due` rows are synced every hour, so a later payment restores Pro within the hour. A sync that fails keeps the stored row and is retried the next hour.
- **A Stripe outage longer than the grace** turns a lapsed row Free until a sync succeeds. Rule 4 makes that safe: nothing is lost, and the next sync restores Pro.
- **Checkout or Portal down:** the route answers `INTERNAL`, and the app says to try again later. Nothing is stored before Stripe answers, apart from the customer ID.
- **A refund or cancellation made by the owner in Stripe's dashboard** shows at the next sync: the user's own `POST /sync`, or the hourly one at period end. The owner can ask the user to refresh. Accepted: an immediate cancellation in the dashboard may leave Pro on until the period end.

## Security and privacy

- **What we store:** the Stripe customer and subscription IDs and the plan state above. **No card data, no billing address, no email** in our tables; Stripe holds those as its own controller ([#54](https://github.com/rojinc/ledgerly/issues/54) to confirm the privacy policy wording).
- **Who can read it:** the user, their own row only. Functions read it with their key.
- **Never logged:** Stripe IDs, statuses tied to a person, amounts, the request or response bodies of Stripe calls, and the `Stripe-Signature` header. Log the route, the error code and Stripe's `request-id` only ([no personal data in logs](security-and-privacy.md#personal-data)).
- **Account deletion** ([#50](https://github.com/rojinc/ledgerly/issues/50)): step 5 of the [order](identity-and-invites.md#order) also deletes the Stripe customer (`DELETE /v1/customers/{id}`, which cancels its subscriptions at once, with no refund), then the `subscriptions` row. A 404 from Stripe counts as done, so a rerun is safe. The delete screen warns that a running subscription ends without a refund (owner question: refunds). Stripe keeps its own payment records for its legal obligations.
- **Execute permissions:** `billing` is `users`, like every function. Its key scopes are `rows.read` and `rows.write`. `account` needs no new Appwrite scope. With the [webhook](#if-the-lead-picks-the-webhook-instead), `stripe-webhook` would be the one `any` function.
- **Secrets** ([inventory](security-and-privacy.md#secrets-inventory)): `STRIPE_SECRET_KEY` holds a Stripe **restricted** key, allowed only Customers (write), Checkout Sessions (write), Billing Portal sessions (write) and Subscriptions (read). It's a function variable on `billing`, not a project variable, so other functions never see it. `account` gets its own restricted key, Customers (write) only, as its own function variable of the same name. `STRIPE_WEBHOOK_SECRET` exists only with the webhook design, on `stripe-webhook` only. Test-mode and live keys are separate values, test on `ledgerly-dev` and live on prod. The owner creates and sets them (D-015).
- **The review** of the follow-up tasks gets the `security` label: a new function, a new table with permissions, and new secrets.

### Dependencies

**None new.** Functions call Stripe's REST API with `fetch` (four form-encoded calls, a `Stripe-Version` header pinned to one API version), as the SMS design does ([#40](https://github.com/rojinc/ledgerly/issues/40)), and the webhook signature check, if built, uses `node:crypto`. If the build finds `fetch` too thin, the `stripe` package is the one to add, with a one-line reason in that PR.

## Owner and legal questions

Listed, not answered (D-015, [#54](https://github.com/rojinc/ledgerly/issues/54)):

1. **Whether to charge at launch,** and the trigger for switching on option b.
2. **Prices:** monthly, yearly or both; in AUD; shown with or without GST.
3. **GST:** registration (the turnover threshold), whether prices include it, and whether to use Stripe Tax. Needs an accountant.
4. **Refunds:** for a cancellation, for account deletion mid-period, and for disputes.
5. **The trial:** whether there is one, how long, and whether it needs a card.
6. **What Pro gates:** confirm or change the [gate table](#what-a-plan-gates).
7. **Existing users** when billing starts: grandfathered, a notice period, or a free period.
8. **Terms of service and privacy policy** wording for payments, with #54.
9. **The Stripe account:** which legal entity and ABN the account and its receipts are in.

## Follow-up tasks

Only once the owner decides to charge. Each is one issue:

1. **contract:** the `subscriptions` table (data-model.md, and its row in permissions.md's row-permission table), the `billing` routes, `PLAN_REQUIRED` in functions-api.md's codes and the gate list, `billing`'s rows in function settings and execute permissions, step 5 of the deletion order in identity-and-invites.md, the zod schemas, and D-019 accepted.
2. **core:** `planOf` and `GATES` in `packages/core/src/billing/`, with full branch coverage.
3. **server:** `requirePlan` and a small Stripe `fetch` client in `packages/server`.
4. **fn billing:** `POST /checkout`, `/portal`, `/sync` and the hourly sync.
5. **fn gates:** `groups`, `statements` and `identity` call `requirePlan` on the gated routes.
6. **fn account:** delete the Stripe customer and the row on account deletion.
7. **web:** a Plan section on Profile (Upgrade, Manage, Refresh) and the `PLAN_REQUIRED` refusal with its feature named.
8. **owner setup:** the Stripe account, the product and price, the Portal settings (cancel at period end, one plan), one subscription per customer if Stripe's setting covers Checkout, the restricted keys as function variables on dev (test mode) and prod (live), and the terms and refund pages.
9. **docs:** tech-stack.md's Stripe line ("added in M4"), roadmap.md's M4 line that lists billing as build work, and features.md's Pro column, when the gates are confirmed.
