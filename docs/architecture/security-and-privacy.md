# Security and privacy

We store people's money records, contact details and bank details. Treat every change here as high risk.

## Threats and controls

| Threat | Control |
| --- | --- |
| A user reads another group's data | Row permissions are `read("team:<groupId>")` only; table-level permissions are empty; teams are managed only by functions. |
| A user writes data they shouldn't | Clients have no write permission anywhere. Functions check `members` role and status on every write. |
| A client pretends to be another user when calling a function | Functions get the caller only from a JWT that Appwrite verifies (`account.get()`), never from `x-appwrite-user-id`, which a client can forge with a mixed-case header. Functions are `users`-only (never `any` or `guests`), so their domains aren't served, and no user is an impersonator ([permissions](permissions.md#function-execute-permissions)). |
| Someone claims another person's history | Claims need an identity **verified** by Appwrite Auth. Unverified data never merges persons. |
| Someone plants another person's email or phone on their own account, or takes rows other groups added under it, by adding it to a placeholder alongside a key of their own and then claiming the placeholder | A new placeholder stores only one typed key, so only whoever verifies that key can claim it; and a claim keeps only the keys the claimer verified, deleting the rest in the transaction that adopts or marks the placeholder. An add stages a guard write on the person it finds, so an add racing a claim is tried again ([only verified keys move](identity-and-invites.md#only-verified-keys-move)). |
| Finding out who is a user by adding them to a group (enumeration) | Members added by someone else always start as placeholders, only the person can join, and person IDs carry no timestamp, so adding someone never reveals whether the email or phone has an account ([D-016](decisions.md)). Accepted: Appwrite's own sign-up says when an email is already registered, and its password recovery answers `user_not_found` or `user_blocked` for an address with no account or a blocked one. The recovery page shows one message for those and for a sent link ([password recovery](identity-and-invites.md#password-recovery)). |
| Someone else holds a session, or set the account's password | Profile's **Sign out other devices** signs out every session but the one in use (`account.listSessions()`, then `account.deleteSession()` for each one that isn't `current`; never `account.deleteSessions()`, which on Appwrite 1.8.1 deletes the current session too), and says how many it signed out. Changing the password there as well keeps out someone who knew the old one. An owner who doesn't know the password resets it by an emailed link that works once, for 1 hour. A reset alone signs out no session, so after one the app signs that browser out and sends the user to sign in, and that sign-in signs out every other session: an intruder's session ends there, and the password they knew no longer works ([password recovery](identity-and-invites.md#password-recovery)). Accepted: until the owner signs in from the page the reset leads to, or uses **Sign out other devices**, the other sessions stay signed in. |
| Teammates seeing each other's account emails | Appwrite's membership privacy setting hides account email, phone, name, MFA status and last access from team members; only the user ID is shown. Project settings aren't pushed by deploys: the lead set it on `ledgerly-dev` through the Appwrite MCP, and it must be set on prod when prod is created ([how](#membership-privacy)). |
| Invite spam or SMS cost abuse | Rate limits: 20 invites per inviter in the last 24 hours, 3 per identity in the last 7 days (rolling), guarded so parallel requests can't pass them together. No invite to or from a person whose account deletion has started, nor to a placeholder being merged into one. Tokens are hashed, single-use and expire in 14 days. The subject is fixed; the only free text is the inviter's name in the group and the group's name, each one line, without bidi control characters, and cut to 40 characters ([invites](identity-and-invites.md#invites)). Accepted, as for reminders: a sender still puts up to 40 characters of their own text, twice (their name in the group, and the group name), into an email to an address that is already that person's identity; and hitting the limit of 3 per identity tells the inviter that someone else invited that address this week. Guessing which address a placeholder is known by: 10 wrong addresses per sender per 24 hours, counted together with reminders' on the sender's own `persons` row, each before its check runs, so a conflict the sender causes can't drop one ([#274](https://github.com/rojinc/ledgerly/issues/274)). Guesses made by adding someone (a matching person ID, or `CONFLICT`) aren't counted: accepted. Accepted too: since a registered person holds every key they verified and a placeholder only one, a second address that passes shows that the member has an account, within that count ([accepted risks](identity-and-invites.md#adding-someone-to-a-group)). |
| Reminder spam ("you owe me" to anyone) | Only a joined admin or member of a pair group, with a verified email, whom the other member owes; only to an address the group already holds for that other member (an address the sender added them with). Rate limits: 1 per sender per group in 3 days, 3 per recipient in 7 days, 20 per sender in 24 hours, guarded like invites and committed before the email is sent. The subject is fixed; the only free text is the sender's name, one line without bidi control characters, cut to 40 characters, and the only link is the app ([reminders](identity-and-invites.md#reminders)). Wrong addresses count against the sender, with invites' (10 per 24 hours, [#274](https://github.com/rojinc/ledgerly/issues/274)). Accepted, as for invites: the recipient limit and the address check each tell the sender a little, and the short name is free text. |
| A stolen session sets or changes the password, to sign in fresh later | The account's verified email gets a notice when the password is set or changed, through the password route or a recovery reset, sent by an event the client can't skip ([password notice](identity-and-invites.md#password-notice)). A first password set through an email or phone change is covered by the [email and phone change notice](identity-and-invites.md#email-and-phone-change-notice). A change through the password route also signs every other session out (the project's session invalidation setting); a recovery reset doesn't yet (#290). Deleting the account is refused for 24 hours after either ([refusals](identity-and-invites.md#refusals)). |
| A stolen session moves the account to another email or phone, to take it over | An email change notifies every old verified address, taken from our own `identities`, never from the event, with no cap. Not only the newest: an attacker who verifies an address of their own on the way (A → B → A → C) would otherwise get the only notice (the lead's call, #314). A phone change notifies the account's verified email. Both are sent by events the client can't skip, name the new address or number only masked, and link only to the sign-in page ([email and phone change notice](identity-and-invites.md#email-and-phone-change-notice)). Accepted: the attacker's own verified address on the way gets a notice too; a replay after Resend's 24-hour key expires sends it again; no notice to the old number until SMS (#175), none when the old email was never verified, and none for a phone change on an account with no verified email; and, for v1, a notice lost to Resend's rate limit of 2 emails a second, shared with the app's other emails: a burst of the stolen session's own reminders or invites at the change can get both tries a 429, leaving only a `change_notice` `failed` error line, since Appwrite doesn't run an event again (the lead on #329; a lasting retry is [#345](https://github.com/rojinc/ledgerly/issues/345)). |
| Edited history | Final statements lock transactions; activity is append-only and written only by functions (a [merge](identity-and-invites.md#merging-two-persons) only repoints `subjectPersonId` from a placeholder to the person it became). |
| Leaked secrets | No secrets in git. Function secrets are Appwrite project variables. CI secrets are GitHub Actions secrets. `.env*` files are git-ignored except `.env.example`. |
| Malicious uploads | `receipts` accepts only images and PDFs up to 10 MB, from verified users only. Files are only shown as images or downloaded, never run. When a file is attached, the ledger limits it to its group's team ([permissions](permissions.md#storage)). Files that no transaction lists are deleted by the scheduler ([step 5](scheduling.md#step-5-receipt-clean-up)): a file that was never attached about 24 hours after its upload, and a file taken off its last transaction about 24 hours after that, so a removal can be undone for a day. So an upload can't be used to host a file for long, though until it's deleted a never-attached file keeps its uploader's permissions, `read("any")` included. Uploads are dealt with oldest first from a stored checkpoint, so a flood of new ones can delay deletion but never makes a file permanent ([scaling](scaling.md#problems-and-fixes)). |
| Injection | Appwrite queries are parameterised; no raw query strings from users. PDFs are built from data, not HTML. |

### Membership privacy

Set it with this command (an API key works), then read it back:

```bash
appwrite project update-membership-privacy-policy --user-id=true --user-name=false --user-email=false --user-phone=false --user-mfa=false --user-accessed-at=false
appwrite project get-policy --policy-id membership-privacy
```

Keep the user ID visible; everything else is hidden.

**Don't put it in `appwrite.config.json`.** Appwrite CLI 28.7.0 ignores `membershipsUserName`, `membershipsUserEmail` and `membershipsMfa` under `settings.auth.security`. `appwrite push settings` reports them as applied but sends nothing, so the config would claim a setting that was never made. `push settings` also needs a console login and refuses API keys.

## Personal data

| Data | Where | Who can see it |
| --- | --- | --- |
| Emails, phone numbers | `identities` | Server only. The owner sees their own in Appwrite Auth. |
| Names | `members.displayName` (what the group calls them) | Members of the shared group. `persons.displayName` is readable only by that user, so a registered person's own name never shows before they join. |
| Bank details, ABN, address | `profiles.businessJson` | The owner; printed on invoices they send |
| Receipts | `receipts` bucket | Members of the group. A receipt taken off its last transaction is deleted about 24 hours later. |
| Money records | ledger tables | Members of the group |
| Reminders sent | `reminders` (who reminded whom, in which group, when; no address and no amount) | Server only. Deleted with either person's account. |

Rules:

- **Collect the minimum.** No address-book upload, no location, no tracking pixels in emails.
- **No personal data in logs**: no emails, phone numbers, names, bank details or amounts with names. Log IDs and error codes.
- **Placeholders** are people who never agreed to our terms. Store only what the adding user typed, and never show their contact details to other members. Delete it on request: an admin removes the placeholder from each group, and 30 days after its last member row goes, the scheduler deletes its person and identities ([removing members](permissions.md#leaving-a-group), [step 5c](scheduling.md#step-5c-placeholder-clean-up)); its invites go 30 days after they're accepted or expire ([step 5b](scheduling.md#step-5b-invite-clean-up)). A group can remove someone only while nothing there names them (no shares, unposted transaction or template), and never the other member of a pair or employer group. Until then their name and the address the group typed stay, as a finalized statement keeps the names it was issued with. For a pair or employer counterpart, or someone with a share on a finalized statement, that's until the group is purged, when the last person in its team deletes their account ([deleting an account](identity-and-invites.md#each-group-they-joined)). The 30 days are so a removal can't test an address: until then, adding it again finds the same person whether or not it has an account. Accepted: an admin who waits them out and adds the address again learns whether it was known elsewhere, at 30 days per address (the lead on [#367](https://github.com/rojinc/ledgerly/pull/367)).
- **Account deletion** removes contact details, the profile and every group no one else is in, and anonymises the person in shared groups. It needs a sign-in from the last 10 minutes ([details](identity-and-invites.md#deleting-an-account-m4)).
- **Data export:** users download their own records and profile as CSV ([below](#data-export)).

Privacy law obligations (for example Australia's Privacy Act) need professional advice before public launch. That is a launch blocker in [roadmap M4](../planning/roadmap.md).

## Data export

F-06 and F-72 ([#50](https://github.com/rojinc/ledgerly/issues/50)). The export is built **in the browser** from rows the user can already read: no function, no stored file, and no access to `identities` or to other people's contact details. It covers the user's own records and their profile, which is what v1 offers for an access request ([#54](https://github.com/rojinc/ledgerly/issues/54) confirms it).

| File | One row per | Columns |
| --- | --- | --- |
| A group's CSV, for a date range | share; a transaction with no shares gets one row with empty person columns | `date,status,kind,description,category,currency,total,person,given,received,net` |
| `my-records.csv` | the user's own share, across their groups | `group,groupType,date,kind,description,category,currency,total,given,received,net` |
| `profile.csv` | profile field | `field,value`: the profile, business details, and the account's own email and phone |

Rules, in `packages/core/src/export/`:

- **Money** is a decimal string made from integer cents with the currency's digits (`-12.30`, `0.05`; JPY `1234`), never through a float. **Dates** are the stored `YYYY-MM-DD`. `person` is the member's display name in that group.
- **RFC 4180:** CRLF line ends, a UTF-8 byte order mark, quotes doubled, and quotes around any field holding `,`, `"`, CR or LF.
- **Spreadsheet formulas:** a text cell starting with `=`, `+`, `-`, `@` (or their full-width forms `＝＋－＠`), after any leading whitespace, or with a tab, CR or LF, gets a leading `'`, so opening the file never runs a formula someone typed. Names, descriptions, categories and profile values are all text cells; money cells never get one.
- Any member can export a group they can read, viewers and people who moved out included. Nothing is written or uploaded.
- **A group's records are one consistent read:** the group's `rev` is read before and after the pages, and everything is read again if it changed (ledger.md#concurrency) or a page's cursor row was deleted mid-read (`general_cursor_not_found`). That's 3 reads in all, whatever the cause, before the export fails, as `GET /balances` does. `my-records.csv` reads again only for a lost cursor, within the same 3.
- **What a spreadsheet does on opening** is outside the file: Excel may drop the leading zeros of a BSB or account number, show an ABN in scientific notation, read a text like `1/2` as a date, or read `12.30` wrongly where the decimal separator is a comma. The values in the file are exact; CSV has no way to mark a column as text.
- **Your data** is two files, offered as two links once both are made, since browsers don't reliably allow two downloads from one click.

## Retention

For v1 ([#50](https://github.com/rojinc/ledgerly/issues/50); the owner's legal review, [#54](https://github.com/rojinc/ledgerly/issues/54), may change it):

- **Final statements and their PDFs stay as issued** after the worker deletes their account, ABN and bank details included, because the other side already holds them ([D-010](decisions.md#d-010-closed-periods-never-change)).
- **A purged group's invoices are deleted** with it. The delete screen tells users to export first.
- **Backups** follow Appwrite Cloud's retention, so deleted data can stay in a backup for that period.
- **Reminders** (`reminders`) hold person and group IDs only, and are kept until either person deletes their account; pruning old rows is a later follow-up.
- **Invites** (`invites`) hold the address each invite went to. Each row is deleted 30 days after the invite is accepted or expires ([scheduler step 5b](scheduling.md#step-5b-invite-clean-up)), or sooner, with a purged group or a deleted account.
- **Address misses** (`persons.addressMisses` and `addressMissesFrom`) hold a count and a time only: no address, target or route. Each new window overwrites them, and they stay on a deleted person's anonymised row, which account deletion doesn't need to clear (the lead on [#274](https://github.com/rojinc/ledgerly/issues/274)).
- **A placeholder's details** (its person and its identities) are deleted 30 days after its last member row is removed ([scheduler step 5c](scheduling.md#step-5c-placeholder-clean-up)), or with its last group's purge. The invites to its rows go by step 5b, as all invites do.
- **Activity rows written before #50** keep the names in their text, as history; rows written since name no one ([activity](data-model.md#activity)).
- **Deleting needs a recent sign-in and an old password.** The session must be under 10 minutes old, and `passwordUpdate` over 24 hours old, so a stolen session can't set a first password, sign in fresh and delete the account the same day ([refusals](identity-and-invites.md#refusals)). Accepted risk: signing in with Google (OAuth, later) would make a fresh session without a password change, so this rule must be revisited when OAuth is added. The account's verified address is emailed whenever a password is set or changed ([password notice](identity-and-invites.md#password-notice)). When the email changes, its old verified addresses are emailed, and when the phone changes, its verified email is ([change notice](identity-and-invites.md#email-and-phone-change-notice)).

## Secrets inventory

| Secret | Lives in | Used by |
| --- | --- | --- |
| Appwrite API key (deploy) | GitHub Actions secret per environment | CI deploy |
| Resend API key | Appwrite project variable `RESEND_API_KEY` | functions |
| SMS provider keys (M3) | Appwrite project variables | `identity` |
| Sentry DSN (M4) | Project variable / Vite env | functions, web |
| Stripe restricted key, once billing is built ([billing](billing.md#security-and-privacy)) | Function variable `STRIPE_SECRET_KEY` on `billing` and `account` only (each its own restricted key), not a project variable; test mode on dev, live on prod | `billing`, `account` |
| Stripe webhook signing secret, only if the webhook design is chosen ([billing](billing.md#if-the-lead-picks-the-webhook-instead)) | Function variable `STRIPE_WEBHOOK_SECRET` on `stripe-webhook` only | `stripe-webhook` |

Functions use the **per-execution key** in `x-appwrite-key` for database access. Long-lived keys exist only for CI deploys and are scoped to what deploys need.

## Security review rule

Any PR that touches permissions, `identity`, auth flows, invites, file access or secrets gets the `security` label. Its review must include a security pass (who can read or write what, enumeration, secrets, logs) before the lead agent merges it.
