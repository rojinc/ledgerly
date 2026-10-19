# Tech stack

**TypeScript everywhere.** React + Vite on the web, Appwrite Cloud as the backend, Expo for mobile later. Domain logic lives once, in `packages/core`.

Adding anything not on this page needs a line in the PR explaining why. See [Code conventions → Dependencies](../engineering/conventions.md#dependencies).

## Frontend (web)

| Need | Choice | Why |
| --- | --- | --- |
| Framework | **React 19 + Vite**, single-page app | Everything sits behind a login, so server rendering adds nothing. React skills carry over to React Native. |
| Phone install | `vite-plugin-pwa` | Installable on phones before native apps exist. |
| Routing | React Router (data router, library mode) | Well known and enough for an SPA. |
| Server state | **TanStack Query** | Caching, retries and optimistic updates. Realtime events invalidate queries. |
| UI kit | **Tailwind CSS + shadcn/ui** | Components are copied into the repo and built on accessible Radix primitives. |
| Forms | react-hook-form + **zod** | The same zod schemas validate in the browser and in functions. |
| Dates | Helpers in `packages/core/src/dates`, with `@date-fns/tz` for time zones | Dates are `YYYY-MM-DD` strings; calendar maths is plain UTC day counting, so only time-zone conversion needs a library. |
| Money | Integer cents + `Intl.NumberFormat` | No money library needed. |
| Phone numbers | `libphonenumber-js` | Puts every number in E.164 form so one number never becomes two people. |
| Calendar | Own CSS-grid month view | About 50 lines. Add FullCalendar only if week view or drag-and-drop is needed. |
| Hosting | Appwrite Sites | Same platform as the backend. |

## Backend (Appwrite Cloud)

| Need | Appwrite product |
| --- | --- |
| Accounts | Auth: email + password, email OTP, later Google OAuth. Phone numbers are only verified, never used to log in ([D-017](decisions.md)) |
| Data | **TablesDB** with multi-row **transactions** |
| Group access | **Teams**: one team per group |
| Files | Storage buckets `receipts` and `statements`, with image previews for thumbnails |
| Live updates | Realtime (respects permissions) |
| Logic | **Functions**, Node.js runtime, TypeScript bundled by esbuild |
| Config as code | Appwrite CLI with `appwrite.config.json` |

Function libraries: `node-appwrite` (server SDK), `pdfmake` (PDFs), `date-holidays` (public holidays), `rrule` (recurrence), `libphonenumber-js`, `zod`.

## Outside services

| Service | Use |
| --- | --- |
| **Resend** | All outgoing email from functions (statements, invites, reminders, summaries). Also used as Appwrite Auth's custom SMTP server so verification emails come from our domain. |
| **SMS provider** (the owner picks it in [#175](https://github.com/rojinc/ledgerly/issues/175)) | Phone invites, sent by functions through its HTTP API with `fetch`, no SDK ([D-017](decisions.md)). Added in M3. |
| **Sentry** | Error tracking for web and functions. Added in M4. |
| **Stripe** | SaaS subscriptions. Added in M4. |

Appwrite Messaging can only message project users, not addresses like an employer's billing email, so we use Resend for every outgoing email. One email path is easier to run than two.

## Tooling

| Need | Choice |
| --- | --- |
| Package manager | **npm workspaces** (ships with Node, nothing extra to install) |
| Node | 24 LTS (`.nvmrc`), locally, in CI and in functions (`node-24`, [function settings](../engineering/environments-and-deploys.md#function-settings)). |
| Lint and format | **Biome** (one tool instead of ESLint + Prettier) |
| Unit tests | **Vitest**, with `@vitest/coverage-v8` for the 100% coverage check in `packages/core`, and `unpdf` to read the text of rendered PDFs |
| End-to-end tests | Playwright (from M2) |
| Function bundling | esbuild, one bundle per function |
| CI/CD | GitHub Actions |
| Types from schema | `appwrite types` |

## Mobile (M5)

Expo + React Native, the Appwrite React Native SDK and the same `packages/core`. The server already enforces every rule, so the mobile app is just another client.

## Deliberately not used

| Not used | Reason |
| --- | --- |
| Next.js / SSR | No public pages need server rendering. A marketing site can be separate later. |
| A separate API server (Express, NestJS) | Appwrite Functions are the API. |
| Redux or similar | TanStack Query plus React state is enough. |
| Turborepo / Nx | Plain workspaces are fine until builds get slow. |
| Appwrite relationship columns | Plain ID columns are explicit and work with bulk operations ([D-006](decisions.md)). |
