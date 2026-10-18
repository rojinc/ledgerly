# Security and privacy

We store people's money records, contact details and bank details. Treat every change here as high risk.

## Threats and controls

| Threat | Control |
| --- | --- |
| A user reads another group's data | Row permissions are `read("team:<groupId>")` only; table-level permissions are empty; teams are managed only by functions. |
| A user writes data they shouldn't | Clients have no write permission anywhere. Functions check `members` role and status on every write. |
| A client pretends to be another user when calling a function | Functions get the caller only from a JWT that Appwrite verifies (`account.get()`), never from `x-appwrite-user-id`, which a client can forge with a mixed-case header. Functions are `users`-only (never `any` or `guests`), so their domains aren't served, and no user is an impersonator ([permissions](permissions.md#function-execute-permissions)). |
| Someone claims another person's history | Claims need an identity **verified** by Appwrite Auth. Unverified data never merges persons. |
| Finding out who is a user by adding them to a group (enumeration) | Members added by someone else always start as placeholders, only the person can join, and person IDs carry no timestamp, so adding someone never reveals whether the email or phone has an account ([D-016](decisions.md)). Accepted: Appwrite's own sign-up says when an email is already registered. |
| Teammates seeing each other's account emails | Appwrite's membership privacy setting hides account email, phone, name, MFA status and last access from team members; only the user ID is shown. Project settings aren't pushed by deploys: the lead set it on `ledgerly-dev` through the Appwrite MCP, and it must be set on prod when prod is created. |
| Invite spam or SMS cost abuse | Rate limits: 20 invites per inviter per day, 3 per identity per week. Tokens are hashed, single-use and expire in 14 days. |
| Edited history | Final statements lock transactions; activity is append-only and written only by functions. |
| Leaked secrets | No secrets in git. Function secrets are Appwrite project variables. CI secrets are GitHub Actions secrets. `.env*` files are git-ignored except `.env.example`. |
| Malicious uploads | `receipts` accepts only images and PDFs up to 10 MB. Files are only shown as images or downloaded, never run. |
| Injection | Appwrite queries are parameterised; no raw query strings from users. PDFs are built from data, not HTML. |

## Personal data

| Data | Where | Who can see it |
| --- | --- | --- |
| Emails, phone numbers | `identities` | Server only. The owner sees their own in Appwrite Auth. |
| Names | `members.displayName` (what the group calls them) | Members of the shared group. `persons.displayName` is readable only by that user, so a registered person's own name never shows before they join. |
| Bank details, ABN, address | `profiles.businessJson` | The owner; printed on invoices they send |
| Receipts | `receipts` bucket | Members of the group |
| Money records | ledger tables | Members of the group |

Rules:

- **Collect the minimum.** No address-book upload, no location, no tracking pixels in emails.
- **No personal data in logs**: no emails, phone numbers, names, bank details or amounts with names. Log IDs and error codes.
- **Placeholders** are people who never agreed to our terms. Store only what the adding user typed, never show their contact details to other members, and delete it on request.
- **Account deletion** removes contact details and the personal group, and anonymises the person in shared groups ([details](identity-and-invites.md#deleting-an-account-m4)).
- **Data export:** users can export their data as CSV (M4).

Privacy law obligations (for example Australia's Privacy Act) need professional advice before public launch. That is a launch blocker in [roadmap M4](../planning/roadmap.md).

## Secrets inventory

| Secret | Lives in | Used by |
| --- | --- | --- |
| Appwrite API key (deploy) | GitHub Actions secret per environment | CI deploy |
| Resend API key | Appwrite project variable `RESEND_API_KEY` | functions |
| SMS provider keys (M3) | Appwrite project variables | `identity` |
| Sentry DSN (M4) | Project variable / Vite env | functions, web |

Functions use the **per-execution key** in `x-appwrite-key` for database access. Long-lived keys exist only for CI deploys and are scoped to what deploys need.

## Security review rule

Any PR that touches permissions, `identity`, auth flows, invites, file access or secrets gets the `security` label. Its review must include a security pass (who can read or write what, enumeration, secrets, logs) before the lead agent merges it.
