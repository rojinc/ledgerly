# Roadmap

Milestones run in order, M0 to M5. Inside a milestone, tasks run **in parallel** wherever their dependencies allow.

- **Task details live in GitHub Issues**: goal, scope, acceptance criteria and test plan. This page is the map; the issue is the spec. Status lives in issue labels, not here.
- **Wave** = the earliest round a task can start in. Every task in the same wave can be worked on at the same time by different agents. A task can start once all of its dependencies are closed.
- Tasks marked **owner** need a person with console or account access.
- M2 and later are labelled `status:needs-spec`. The lead agent writes and approves their full spec using [Writing a task](../collaboration/writing-tasks.md) before they become `status:ready`.

## How the work flows

```
M0 Foundation ──► M1 Ledger core + Employer (MVP) ──► M2 Personal + Lend & borrow ──► M3 Houses ──► M4 Launch ──► M5 Mobile
                   exit: owner invoices a real                                                        exit: public
                   employer from the app                                                              launch
```

**Critical path through M1:** #1 → #5 → #7 → #8 → #9 → #20 → #21 → #22 → #25 → #32. Keep these moving first; everything else fills in around them.

**Most parallel moments:** wave 3 (CI, dates, schema, API schemas, identity normalisation, settle) and wave 9 (timer and balances, scheduler, statements, calendar). That's when it pays to run 4–6 agents at once.

## Exit criteria

| Milestone | Done when |
| --- | --- |
| M0 | A clean clone builds and tests green in CI; the schema and five health-check functions are deployed to dev by CI; you can sign up and log in on dev. |
| M1 | The owner runs a whole month in the app: a Thursday schedule, an extra-hours shift, an expense, a payment, then a finalized and emailed invoice whose PDF needs no manual fixes. |
| M2 | Personal bills with reminders, lend/borrow with a placeholder, dashboard reports, summary emails; end-to-end tests cover flows 1–5. |
| M3 | A house of three closes a month: itemised receipts, a days-present bill, settle-up and a monthly divide PDF; an invited housemate claims their history. |
| M4 | Nightly invariant check is clean for 2 weeks; account deletion and export work; legal review done; billing decided. Public launch. |
| M5 | Mobile app spike signed off. |


## M0 Foundation

Monorepo, CI, Appwrite schema as code, function and web skeletons, deploys.

| Issue | Task | Area | Depends on | Wave | Who |
| --- | --- | --- | --- | :---: | --- |
| [#1](https://github.com/rojinc/ledgerly/issues/1) | Monorepo tooling: npm workspaces, TypeScript, Biome, Vitest | infra | none | 1 | agent |
| [#2](https://github.com/rojinc/ledgerly/issues/2) | CI workflow: lint, typecheck, test, build on every PR | infra | [#1](https://github.com/rojinc/ledgerly/issues/1), [#5](https://github.com/rojinc/ledgerly/issues/5) | 3 | agent |
| [#3](https://github.com/rojinc/ledgerly/issues/3) | Owner setup: Appwrite projects, API keys, email and GitHub secrets | infra | none | 1 | owner |
| [#4](https://github.com/rojinc/ledgerly/issues/4) | Owner setup: connect GitBook Git Sync to docs/ | docs | none | 1 | owner |
| [#5](https://github.com/rojinc/ledgerly/issues/5) | core: package setup + money module (allocate, format, shift amount) + constants | core | [#1](https://github.com/rojinc/ledgerly/issues/1) | 2 | agent |
| [#6](https://github.com/rojinc/ledgerly/issues/6) | core: dates module (LocalDate helpers, periods, close times) | core | [#5](https://github.com/rojinc/ledgerly/issues/5) | 3 | agent |
| [#7](https://github.com/rojinc/ledgerly/issues/7) | contract: Appwrite schema as code (tables, indexes, buckets) + generated row types | appwrite | [#1](https://github.com/rojinc/ledgerly/issues/1), [#3](https://github.com/rojinc/ledgerly/issues/3), [#5](https://github.com/rojinc/ledgerly/issues/5) | 3 | agent |
| [#8](https://github.com/rojinc/ledgerly/issues/8) | server: package skeleton (handler, errors, client, transactions, requireMember, fake DB) | server | [#5](https://github.com/rojinc/ledgerly/issues/5), [#7](https://github.com/rojinc/ledgerly/issues/7) | 4 | agent |
| [#9](https://github.com/rojinc/ledgerly/issues/9) | Function bundling + skeletons for all five functions (health route), deployed to dev | functions | [#8](https://github.com/rojinc/ledgerly/issues/8) | 5 | agent |
| [#10](https://github.com/rojinc/ledgerly/issues/10) | web: app shell with auth (Vite, React, Tailwind, shadcn, Router, Query, PWA) | web | [#1](https://github.com/rojinc/ledgerly/issues/1) | 2 | agent |
| [#11](https://github.com/rojinc/ledgerly/issues/11) | Deploy workflow: main → dev, tags → prod | infra | [#2](https://github.com/rojinc/ledgerly/issues/2), [#3](https://github.com/rojinc/ledgerly/issues/3), [#7](https://github.com/rojinc/ledgerly/issues/7), [#9](https://github.com/rojinc/ledgerly/issues/9), [#10](https://github.com/rojinc/ledgerly/issues/10) | 6 | agent |

## M1 Ledger core + Employer (MVP)

The ledger in packages/core, the five functions, and the employer module end to end. Exit: the owner invoices a real employer from the app.

| Issue | Task | Area | Depends on | Wave | Who |
| --- | --- | --- | --- | :---: | --- |
| [#12](https://github.com/rojinc/ledgerly/issues/12) | contract: zod schemas for the Functions API | core | [#5](https://github.com/rojinc/ledgerly/issues/5) | 3 | agent |
| [#13](https://github.com/rojinc/ledgerly/issues/13) | core: identity normalisation (email, phone → identity key) | core | [#5](https://github.com/rojinc/ledgerly/issues/5) | 3 | agent |
| [#14](https://github.com/rojinc/ledgerly/issues/14) | core: splits, buildShares and ledger invariants | core | [#6](https://github.com/rojinc/ledgerly/issues/6), [#12](https://github.com/rojinc/ledgerly/issues/12) | 4 | agent |
| [#15](https://github.com/rojinc/ledgerly/issues/15) | core: balances and suggested transfers (settle up) | core | [#5](https://github.com/rojinc/ledgerly/issues/5) | 3 | agent |
| [#16](https://github.com/rojinc/ledgerly/issues/16) | core: recurrence (expandSchedule, public holidays, occurrence IDs) | core | [#6](https://github.com/rojinc/ledgerly/issues/6) | 4 | agent |
| [#17](https://github.com/rojinc/ledgerly/issues/17) | core: statement snapshot builder and checks | core | [#12](https://github.com/rojinc/ledgerly/issues/12), [#14](https://github.com/rojinc/ledgerly/issues/14), [#15](https://github.com/rojinc/ledgerly/issues/15) | 5 | agent |
| [#18](https://github.com/rojinc/ledgerly/issues/18) | server: email module (Resend over fetch) + first templates | server | [#8](https://github.com/rojinc/ledgerly/issues/8) | 5 | agent |
| [#19](https://github.com/rojinc/ledgerly/issues/19) | server: invoice PDF with pdfmake | server | [#8](https://github.com/rojinc/ledgerly/issues/8), [#12](https://github.com/rojinc/ledgerly/issues/12) | 5 | agent |
| [#20](https://github.com/rojinc/ledgerly/issues/20) | fn identity: bootstrap, profile, claim (adopt only) + resolvePerson | functions | [#6](https://github.com/rojinc/ledgerly/issues/6), [#8](https://github.com/rojinc/ledgerly/issues/8), [#9](https://github.com/rojinc/ledgerly/issues/9), [#12](https://github.com/rojinc/ledgerly/issues/12), [#13](https://github.com/rojinc/ledgerly/issues/13) | 6 | agent |
| [#21](https://github.com/rojinc/ledgerly/issues/21) | fn groups: groups, members, settings | functions | [#6](https://github.com/rojinc/ledgerly/issues/6), [#20](https://github.com/rojinc/ledgerly/issues/20) | 7 | agent |
| [#22](https://github.com/rojinc/ledgerly/issues/22) | fn ledger: create, update, post and void transactions | functions | [#14](https://github.com/rojinc/ledgerly/issues/14), [#21](https://github.com/rojinc/ledgerly/issues/21) | 8 | agent |
| [#23](https://github.com/rojinc/ledgerly/issues/23) | fn ledger: timer start/stop and balances route | functions | [#15](https://github.com/rojinc/ledgerly/issues/15), [#22](https://github.com/rojinc/ledgerly/issues/22) | 9 | agent |
| [#24](https://github.com/rojinc/ledgerly/issues/24) | fn scheduler: schedule routes, expansion, auto-post shifts, reminders | functions | [#16](https://github.com/rojinc/ledgerly/issues/16), [#18](https://github.com/rojinc/ledgerly/issues/18), [#22](https://github.com/rojinc/ledgerly/issues/22) | 9 | agent |
| [#25](https://github.com/rojinc/ledgerly/issues/25) | fn statements: invoices (draft, refresh, finalize, send, void, reissue, preview) | functions | [#17](https://github.com/rojinc/ledgerly/issues/17), [#18](https://github.com/rojinc/ledgerly/issues/18), [#19](https://github.com/rojinc/ledgerly/issues/19), [#22](https://github.com/rojinc/ledgerly/issues/22) | 9 | agent |
| [#26](https://github.com/rojinc/ledgerly/issues/26) | web: bootstrap on login + profile and business details | web | [#10](https://github.com/rojinc/ledgerly/issues/10), [#20](https://github.com/rojinc/ledgerly/issues/20) | 7 | agent |
| [#27](https://github.com/rojinc/ledgerly/issues/27) | web: groups list + employer group setup and settings | web | [#10](https://github.com/rojinc/ledgerly/issues/10), [#21](https://github.com/rojinc/ledgerly/issues/21) | 8 | agent |
| [#28](https://github.com/rojinc/ledgerly/issues/28) | web: calendar month view | web | [#10](https://github.com/rojinc/ledgerly/issues/10), [#22](https://github.com/rojinc/ledgerly/issues/22) | 9 | agent |
| [#29](https://github.com/rojinc/ledgerly/issues/29) | web: shifts and Today timer | web | [#23](https://github.com/rojinc/ledgerly/issues/23), [#27](https://github.com/rojinc/ledgerly/issues/27) | 10 | agent |
| [#30](https://github.com/rojinc/ledgerly/issues/30) | web: schedules with live preview | web | [#24](https://github.com/rojinc/ledgerly/issues/24), [#27](https://github.com/rojinc/ledgerly/issues/27) | 10 | agent |
| [#31](https://github.com/rojinc/ledgerly/issues/31) | web: employer expenses, payments, balance and history | web | [#23](https://github.com/rojinc/ledgerly/issues/23), [#27](https://github.com/rojinc/ledgerly/issues/27) | 10 | agent |
| [#32](https://github.com/rojinc/ledgerly/issues/32) | web: invoices (draft review, finalize & send, PDF) | web | [#25](https://github.com/rojinc/ledgerly/issues/25), [#27](https://github.com/rojinc/ledgerly/issues/27) | 10 | agent |

## M2 Personal + Lend & borrow

Personal bills, recurring bills, lend & borrow, dashboard and reports, summary emails, end-to-end tests.

| Issue | Task | Area | Depends on | Wave | Who |
| --- | --- | --- | --- | :---: | --- |
| [#33](https://github.com/rojinc/ledgerly/issues/33) | Bills: due → paid, recurring bills, autopay and bill reminders | functions, web | needs spec | - | agent |
| [#34](https://github.com/rojinc/ledgerly/issues/34) | Lend & borrow: pair groups UI, including the pending groups list (routes in [#76](https://github.com/rojinc/ledgerly/issues/76), D-016) | web | needs spec | - | agent |
| [#35](https://github.com/rojinc/ledgerly/issues/35) | Personal dashboard and reports | core, web | needs spec | - | agent |
| [#36](https://github.com/rojinc/ledgerly/issues/36) | Summary emails (weekly, fortnightly, monthly) | functions | needs spec | - | agent |
| [#37](https://github.com/rojinc/ledgerly/issues/37) | Archive groups | functions, web | needs spec | - | agent |
| [#38](https://github.com/rojinc/ledgerly/issues/38) | End-to-end tests for user flows 1–5 (Playwright) | web | needs spec | - | agent |

## M3 Houses

Houses: invites and claim/merge, itemised receipts, receipts upload, days-present bills, settle up, monthly divide, activity, realtime.

| Issue | Task | Area | Depends on | Wave | Who |
| --- | --- | --- | --- | :---: | --- |
| [#39](https://github.com/rojinc/ledgerly/issues/39) | Identity: merge persons + email invites + accept flow | functions | needs spec | - | agent |
| [#40](https://github.com/rojinc/ledgerly/issues/40) | SMS invites + phone verification | functions, web | needs spec | - | agent |
| [#41](https://github.com/rojinc/ledgerly/issues/41) | House groups: members, move in/out, roles | functions, web | needs spec | - | agent |
| [#42](https://github.com/rojinc/ledgerly/issues/42) | Itemised receipts UI | web | needs spec | - | agent |
| [#43](https://github.com/rojinc/ledgerly/issues/43) | Receipt uploads (compress, attach, view) | web, functions | needs spec | - | agent |
| [#44](https://github.com/rojinc/ledgerly/issues/44) | Days-present bills UI | web | needs spec | - | agent |
| [#45](https://github.com/rojinc/ledgerly/issues/45) | Settle up UI + record settlement | web | needs spec | - | agent |
| [#46](https://github.com/rojinc/ledgerly/issues/46) | Monthly divide statements (function + PDF + UI) | functions, server, web | needs spec | - | agent |
| [#47](https://github.com/rojinc/ledgerly/issues/47) | Activity feed UI | web | needs spec | - | agent |
| [#48](https://github.com/rojinc/ledgerly/issues/48) | Realtime updates | web | needs spec | - | agent |

## M4 Hardening + SaaS launch

Balances cache, invariant checks, account deletion and export, error tracking, onboarding, legal review, billing. Exit: public launch.

| Issue | Task | Area | Depends on | Wave | Who |
| --- | --- | --- | --- | :---: | --- |
| [#49](https://github.com/rojinc/ledgerly/issues/49) | Balances cache table + nightly invariant check | functions, appwrite | needs spec | - | agent |
| [#50](https://github.com/rojinc/ledgerly/issues/50) | Account deletion + data export (CSV) | functions, web | needs spec | - | agent |
| [#51](https://github.com/rojinc/ledgerly/issues/51) | Error tracking (Sentry) + logging review | infra | needs spec | - | agent |
| [#52](https://github.com/rojinc/ledgerly/issues/52) | Onboarding flow | web | needs spec | - | agent |
| [#53](https://github.com/rojinc/ledgerly/issues/53) | Work-hours cap alert | core, web | needs spec | - | agent |
| [#54](https://github.com/rojinc/ledgerly/issues/54) | Privacy policy, terms and legal review (owner) | - | needs spec | - | owner |
| [#55](https://github.com/rojinc/ledgerly/issues/55) | Spike: subscription billing with Stripe | functions | needs spec | - | agent |
| [#56](https://github.com/rojinc/ledgerly/issues/56) | Send-a-reminder to a person (email/SMS) | functions, web | needs spec | - | agent |

## M5 Mobile

Expo / React Native app on the same backend and packages/core.

| Issue | Task | Area | Depends on | Wave | Who |
| --- | --- | --- | --- | :---: | --- |
| [#57](https://github.com/rojinc/ledgerly/issues/57) | Spike: Expo mobile app (auth, calendar, timer) | mobile | needs spec | - | agent |
