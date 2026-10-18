# Security and privacy

We store people's money records, contact details and bank details. Treat every change here as high risk.

## Threats and controls

| Threat | Control |
| --- | --- |
| A user reads another group's data | Row permissions are `read("team:<groupId>")` only; table-level permissions are empty; teams are managed only by functions. |
| A user writes data they shouldn't | Clients have no write permission anywhere. Functions check `members` role and status on every write. |
| Someone claims another person's history | Claims need an identity **verified** by Appwrite Auth. Unverified data never merges persons. |
| Finding out who is a user (enumeration) | Adding a member never reveals whether the email or phone has an account. |
| Invite spam or SMS cost abuse | Rate limits: 20 invites per inviter per day, 3 per identity per week. Tokens are hashed, single-use and expire in 14 days. |
| Edited history | Final statements lock transactions; activity is append-only and written only by functions. |
| Leaked secrets | No secrets in git. Function secrets are Appwrite project variables. CI secrets are GitHub Actions secrets. `.env*` files are git-ignored except `.env.example`. |
| Malicious uploads | `receipts` accepts only images and PDFs up to 10 MB. Files are only shown as images or downloaded, never run. |
| Injection | Appwrite queries are parameterised; no raw query strings from users. PDFs are built from data, not HTML. |

## Personal data

| Data | Where | Who can see it |
| --- | --- | --- |
| Emails, phone numbers | `identities` | Server only. The owner sees their own in Appwrite Auth. |
| Names | `persons.displayName`, `members.displayName` | Members of the shared group |
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
