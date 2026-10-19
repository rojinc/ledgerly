# Mobile spike (M5)

Can the mobile app be "just another client": the same Appwrite project, the same functions and the same `packages/core`? ([#57](https://github.com/rojinc/ledgerly/issues/57))

**So far: yes.** Everything a laptop can prove passes, with `packages/core` unchanged and no server change. The on-device checklist is the owner's and is [still to run](#on-device-results-owner). The spike hit neither stop rule (2 days, or a blocker needing a core, contract or backend change).

## Where the code is

On the branch [`spike/57-expo`](https://github.com/rojinc/ledgerly/tree/spike/57-expo) at commit [`9c6d1c1`](https://github.com/rojinc/ledgerly/commit/9c6d1c190fbd614c0a4c501f87cbcc8a14cbb019), in `apps/mobile`. The branch is kept and **never merged**, so Expo stays out of every `npm ci` on `main`.

It has four screens, with no navigation library:

- **Sign in:** email and password, or an emailed code. After sign-in it calls `identity POST /bootstrap`.
- **Checks:** core run on the phone, compared with the values Node gives.
- **Calendar:** a month of the user's joined groups, read only, with previous and next month.
- **Today:** start and stop a timer in an employer group the user owns and is admin of (as the web's Today page), through `ledger` executions.

The app has **no table writes**: a search finds no `createRow`, `updateRow` or `deleteRow` in it (D-003).

## Versions

| Package | Version | Note |
| --- | --- | --- |
| Expo SDK | 58.0.14 | Managed, made with `create-expo-app` 5.0.0 (`blank-typescript`) |
| React Native | 0.88.0 | Hermes |
| React | 19.3.0, exactly | The web app has `^19.3.1` ([two Reacts](#two-reacts)) |
| TypeScript | 6.0.x in `apps/mobile` | The repo root has 7.0.2 ([TypeScript](#typescript)) |
| `react-native-appwrite` | 2.0.0 | The Appwrite SDK for React Native |
| `@tanstack/react-query` | 5.104.4 | The same as the web app |
| `react-native-safe-area-context` | 5.10.x | Keeps screens clear of the status bar: SDK 58 Android draws edge to edge, and React Native's own `SafeAreaView` is iOS-only. It ships in Expo Go. |
| Node | 24 | As the repo |

## How to run it (owner)

1. Add Expo Go's identifier `host.exp.exponent` as an Android and an iOS platform on `ledgerly-dev`. Remove both after sign-off.
2. `git checkout spike/57-expo && npm ci`.
3. Make `apps/mobile/.env.local` from `apps/mobile/.env.example`, with the dev endpoint and project ID.
4. `npm start -w @ledgerly/mobile`, then scan the QR code with Expo Go. Expo Go must support SDK 58.
5. Use a test account and made-up groups. Post no personal data in results or screenshots.

## What the container proved

| Check | Result |
| --- | --- |
| `tsc --noEmit` in `apps/mobile` | Pass |
| The Checks values under Node (Vitest), `TZ=UTC` and `TZ=Australia/Sydney` | Pass, 18 of 18 |
| `npx expo export --platform android --platform ios` | Pass, about 1,050 modules per platform |
| The repo's `npm run lint`, `typecheck`, `test` (both time zones) and `build` on the spike branch | Pass |

### The checks

`apps/mobile/src/checks.ts` runs core with fixed instants, so neither the phone's nor the machine's time zone changes a value. A Vitest test writes the expected values from Node (`checks.expected.json`); none is typed by hand. The phone compares its own results with that file.

| Check | Node gives |
| --- | --- |
| `localToday` in Sydney, at the last second of 3 Oct 2026 and the first of 4 Oct (DST starts that day) | `2026-10-03`, `2026-10-04` |
| `localToday` in New York, at the last second of 7 Mar 2026 and the first of 8 Mar (DST starts that day) | `2026-03-07`, `2026-03-08` |
| `localTimeToUtc` 06:00 in Sydney, the day before DST and the DST day | `2026-10-02T20:00:00.000Z`, `2026-10-03T19:00:00.000Z` |
| `localTimeToUtc` in New York: 06:00 on the DST day, and 01:00 when DST ends (an hour that happens twice) | `2026-03-08T10:00:00.000Z`, `2026-11-01T05:00:00.000Z` |
| `closeAtFor` a period ending 3 Oct (Sydney) and 31 Oct (New York) | `2026-10-03T19:00:00.000Z`, `2026-11-01T11:00:00.000Z` |
| `formatMoney` AUD and JPY, `formatNet` a negative AUD amount, all `en-AU` | `$1,234.56`, `JPY 1,234`, `-$12.30` |
| The timer-start zod schema: accepts a body, refuses fractional cents | `true`, `false` |
| `rrule`: Thursdays in October 2026 | 5 dates |
| `AU-NSW` public holidays in 2027 (`date-holidays`) | 14 dates |
| `normalizePhone` for an Australian mobile, from the range set aside for fiction | `+61491570156` |

The screen also shows the phone's time zone and locale, which `localToday` and `bootstrap` use. The Hermes `Intl` risks (`formatToParts` with a `timeZone`, `timeZoneName: 'longOffset'` in `@date-fns/tz`, and exact decimal strings in `Intl.NumberFormat`) show up as failures here, so a phone run settles them.

## On-device results (owner)

To be filled in from the owner's run, iOS and Android if both are available.

| Step | iOS | Android |
| --- | --- | --- |
| 1. Sign in with a password, then close and reopen the app: still signed in | | |
| 1b. Sign in with an emailed code | | |
| 2. The Checks screen is all pass (if not, a screenshot of the failures) | | |
| 3. The calendar shows this month's entries on the right days. Open next month and come back. | | |
| 4. Start a timer, wait a minute, stop it. The web's Today page shows the stopped shift. | | |
| 5. Log out, then reopen the app: signed out | | |

## What broke, and the fixes

### Core in Metro: works unchanged

Expo's default Metro config handles the npm workspace by itself. It watches the repo root, resolves `@ledgerly/core`'s subpath `exports` (`"./*": "./src/*.ts"`) and transpiles its TypeScript. The app needs no `metro.config.js`, and core needs no change.

### Two Reacts

Expo pins `react` to exactly 19.3.0. React Native 0.88's renderer refuses any other version. The web app has `^19.3.1`, so npm keeps 19.3.1 at the root and puts 19.3.0 in `apps/mobile/node_modules`.

The bundle still has **one** React, the app's. The source map shows it, with or without a custom Metro config, because Expo's config looks in the app's `node_modules` first.

The risk is the next version bump. **For M5:** web and mobile should use the same React. The web app can follow the version Expo pins; it's a one-line change.

### TypeScript

The Expo template wants TypeScript `~6.0.3`, and the root has 7.0.2. npm installs 6 inside `apps/mobile`, so the app's `tsc` runs 6, while Expo's own tooling ran on the root's 7 without trouble.

Vitest's transform can't resolve `"extends": "expo/tsconfig.base"` without the `.json` ending. The app's tsconfig names `expo/tsconfig.base.json`.

### The Appwrite SDK pins an old `expo-file-system`

`react-native-appwrite` 2.0.0 depends on `expo-file-system` `18.*`, while SDK 58 ships 58.x. So npm nests an old copy inside the SDK.

- **It's safe while unused:** version 18 loads its native module as optional. In Expo Go it may find SDK 58's own native module rather than its shim, so its calls could reach a newer native API.
- **Only file uploads use it,** and the spike doesn't upload.
- **For M5,** receipts on mobile (#43) would hit it. So would a development build, which would autolink two versions. It needs a fixed SDK release or an npm `overrides` entry.

### How the session is kept

- **Storage:** the SDK sends requests with `credentials: 'include'`, so the session cookie lives in the platform's own cookie store, not in JavaScript. Whether it survives a restart is step 1 on the phone.
- **Origin:** every request carries `Origin: appwrite-<android|ios>://host.exp.exponent`. That's why Expo Go's identifier must be a platform on the project.
- **The JWT:** functions get the caller's JWT from Appwrite itself on each execution ([permissions](../architecture/permissions.md#function-side-checks)). The app never sets an `x-appwrite-*` header.
- **Log out** deletes the current session and clears the query cache. A 401 on any read or call sends the user back to Sign in.
- **No refetch on return to the app:** TanStack Query's `focusManager` and `onlineManager` aren't wired to React Native's `AppState` and network state, so nothing refetches when the app comes back to the foreground. That's an M5 task.

### Install size

The app adds 898 packages to `npm ci`. `node_modules` grew from 554 MB to 869 MB on this branch. `npm audit` lists 23 advisories in the Expo tree; none were looked into for the spike.

The template also ships its own `AGENTS.md`, `.claude/` folder and `LICENSE`. They were deleted: this repo's AGENTS.md is the only one that applies.

## Bundle size

- **Android:** the Hermes bytecode bundle is **6.0 MB** (6,014,781 bytes) from a plain `expo export`, and 5.1 MB when the source map is split out (`--dump-sourcemap`). iOS is the same within a few KB.
- **Source:** 7.8 MB in all, read from the source map before minifying. This is how it splits.

| Part | Source | Share |
| --- | --- | --- |
| `date-holidays` and its data (`astronomia`, `moment`, `date-holidays-parser` and others) | 1,620 KB | 21% |
| The Appwrite SDK with `mqtt`, `buffer`, `bignumber.js` and the old `expo-file-system` | 1,511 KB | 19% |
| `zod` | 834 KB | 11% |
| `libphonenumber-js` | 441 KB | 6% |
| `rrule` | 127 KB | 2% |
| `packages/core` itself | 41 KB | 0.5% |
| `@date-fns/tz` | 27 KB | 0.4% |

**Core and its dependencies are 40% of the source,** and `date-holidays` is half of that. On a phone, public holidays only matter for previewing schedules. The M5 build could load it only when the schedule form opens, or ask `scheduler POST /schedules/preview`, which already exists. The SDK's Push and realtime code (`mqtt`) is bundled even though the app doesn't use it.

## Shared code: what should move

These are in `apps/web` and should be shared. The spike copied the first one and wrote simpler versions of the rest:

| What | Today | Move to |
| --- | --- | --- |
| `callFunction`, `parseEnvelope` and the error codes | `apps/web/src/lib/api.ts` | A new `packages/client`, taking the SDK's `Functions` as a parameter. The web `appwrite` package and `react-native-appwrite` have the same shapes but different types. |
| The joined-groups query (teams, then groups) | `features/groups/use-groups.ts` | `packages/client` |
| The month query, `listAll` and the running-timer query | `features/calendar/use-month-transactions.ts`, `features/shifts/use-shifts.ts` | `packages/client` |
| Bootstrap | `features/auth/use-bootstrap.ts` | `packages/client` |
| Query keys | `lib/query-keys.ts` | `packages/client` |
| The month grid (pure) | `features/calendar/month-grid.ts` | `packages/core/dates` |

### A possible core data issue

`date-holidays` lists Monday 26 April 2027 as an `AU-NSW` public holiday, since Anzac Day falls on a Sunday that year. Whether NSW actually adds that Monday should be checked against the NSW gazette, separately from this spike. It's core's data, the same on web and phone.

## The permanent layout: a recommendation

**Keep `apps/mobile` in the npm workspace (option A) for the M5 build, once web and mobile use the same React.**

- **For:** Metro and the workspace worked with no config at all, and core is used as source, with one copy of each dependency.
- **The cost:** about 315 MB and 900 packages more in every `npm ci`, CI included.
- **If that cost matters more than the setup,** use option C: a `mobile/` folder outside the workspaces, with its own lockfile and core through `file:`. Then Metro needs `watchFolders` for core, and core's dependencies install twice.

## Suggested M5 tasks

1. **contract or chore:** align React between web and mobile; decide the layout (above).
2. **chore:** `packages/client` with the shared calls and queries listed above, used by web first.
3. **chore:** the `react-native-appwrite` file-system pin: an `overrides` entry, or an SDK release, before receipts on mobile.
4. **mobile:** the app shell, with navigation, sign-up and verification, password reset, TanStack's focus and online managers wired to React Native, and the platform's real bundle IDs registered (owner).
5. **mobile:** a development build (EAS) once a native module is needed (push, camera).
6. **mobile:** load `date-holidays` only for the schedule form, or use `/schedules/preview`.
7. **owner:** remove `host.exp.exponent` from `ledgerly-dev` after sign-off.
