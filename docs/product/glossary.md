# Glossary

Use these words exactly as defined here, in code, the UI and docs. If you need a new term, add it here in the same PR.

| Term | Meaning |
| --- | --- |
| **User** | An Appwrite Auth account. Someone who signed up. |
| **Person** | Anyone who can owe or be owed money. A person may or may not have a user account. One row in `persons`. |
| **Placeholder** | A person with no user account yet, such as an employer, a landlord's agent or a friend who hasn't joined. As a member status, `placeholder` means the person hasn't joined that group yet, with or without an account; the UI shows both as "not joined". |
| **Identity** | An email address or phone number that belongs to a person. Stored in `identities`. *Verified* means the user proved they own it. |
| **Claim** | Linking a placeholder to a user after the user verifies a matching identity. |
| **Join** | A person entering a group by their own action (claim, accepting an invite, or joining from the app). Their status becomes `active`, or `left` if they had already moved out. |
| **Pending (group)** | A group someone was added to while they already had an account, and hasn't joined yet. They see only its name, type and whether it's archived until they join. |
| **Merge** | Combining two persons that turn out to be the same human. |
| **Profile** | A user's settings and business details. One per user. |
| **Group** | A container of people and transactions. Types: `personal`, `house`, `employer`, `pair`. Each group is one Appwrite Team. |
| **Member** | A person in a group, with a role (`admin`, `member`, `viewer`) and a status (`placeholder`, `active`, `left`). |
| **Counterpart** | The other person in an `employer` or `pair` group. |
| **Archived (group)** | A group made read-only for good (`archivedAt` set). Its history stays; its schedules, reminders and statements stop. A personal group can't be archived. |
| **Owner (of a group)** | The person who created it. In an employer group, the owner is the worker who issues invoices. |
| **Transaction** | One event that involves money or work: a shift, expense, bill, payment, loan, income or adjustment. |
| **Kind** | The type of a transaction (`shift`, `expense`, `bill`, `payment`, `loan`, `income`, `adjustment`). |
| **Status** | Where a transaction is in its life: `scheduled`, `running`, `due`, `posted`, `void`. Only `posted` transactions affect balances. |
| **Share** | One person's part in a posted transaction: what they **gave** and what they **received**. |
| **Given** | The value a person put in: money they paid, or work they did. |
| **Received** | The value a person got out: their share of a purchase, or money paid to them. |
| **Net** | Given minus received. Positive means the group owes you. Negative means you owe the group. |
| **Balance** | The sum of a person's nets in a group over all posted transactions. |
| **Split** | The rule for dividing an amount between people: `equal`, `exact`, `percent`, `weights` or `days`. |
| **Days present** | The number of days a member lived in the house during a bill's period. Used for the `days` split. |
| **Item** | One line of an itemised receipt, with its own split. |
| **Schedule** | A rule that creates transactions automatically, such as "every Thursday 5h at $25". |
| **Occurrence** | One date produced by a schedule. |
| **Overridden** | An occurrence the user edited, so schedule changes leave it alone. |
| **Horizon** | How far ahead a schedule creates occurrences (default 56 days). |
| **Period** | A date range for a statement or a summary email: weekly, fortnightly or monthly. |
| **Statement** | A summary of a group for a period. In an employer group it is an **invoice**; in a house it is a **monthly divide**. |
| **Draft / Final / Void** | Statement states. Final statements are locked; void ones are cancelled but kept. |
| **Locked** | A transaction included in a final statement. It cannot be edited or voided. |
| **Adjustment** | A correcting transaction with explicit shares. The only way to fix a locked transaction. |
| **Settle up** | Payments that bring balances back to zero. **Suggested transfers** are the fewest payments needed. |
| **Activity** | The append-only log of who did what in a group. |
| **Local date** | A calendar date as text, `YYYY-MM-DD`, in the group's timezone. |
| **Cents** | Integer amounts in the smallest currency unit. $12.34 is `1234`. |
