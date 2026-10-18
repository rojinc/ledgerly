# Vision and scope

## The problem

People who do gig work, share a house or lend money usually track it in notes, spreadsheets and memory. That leads to:

- forgotten extra hours and wrong invoices,
- arguments about who paid for what,
- bills paid late,
- loans nobody remembers.

## The product in one sentence

One place to record work, bills and shared spending, which turns them into balances, statements and invoices automatically.

## Principles

These settle arguments about features and design. If a proposal breaks one, it needs a very good reason.

1. **Numbers always add up.** Every cent comes from a transaction. Nobody types a total by hand.
2. **Automate the regular stuff.** A Thursday shift or the monthly rent is set up once as a schedule.
3. **Nothing changes behind your back.** Sent invoices and closed months never change. Corrections are new entries.
4. **Works with people who aren't users.** You can bill an employer or lend to a friend who never signs up.
5. **Enter once, see everywhere.** Your share of the house groceries counts in your personal spending without being entered twice.
6. **Simple first.** Build the smallest thing that solves the real problem, then improve it with real use.

## The four modules

All four are the same data model with different screens. See [The ledger](../architecture/ledger.md).

| Module | Group type | Main job |
| --- | --- | --- |
| Employer | `employer` | Track shifts, expenses and payments, and send invoices |
| House | `house` | Split bills and groceries, run a monthly divide and settle up |
| Personal | `personal` | Track rent, bills and subscriptions, and see spending |
| Lend and borrow | `pair` | Track money lent to or borrowed from one person |

## Target users (first release)

- **Gig workers** who bill one or more employers by the hour. The founder is user number one.
- **Share houses** of 2–8 people.
- **Individuals** who want bill reminders and a spending overview.

Launch market: **Australia** (AUD, state public holidays). Other countries come later.

## In scope for v1 (web)

- Accounts, profiles and business details for invoices.
- All four modules, as listed in [Features](features.md).
- Calendar, history, balances, statements and PDF invoices.
- Email notifications.
- Inviting people by email or phone, including people who are not registered yet.

## Out of scope (for now)

| Not doing | Why |
| --- | --- |
| Moving money (payments, wallets, bank feeds) | We record settlements only. Handling money brings licensing and compliance work. |
| Payroll, tax lodgement, superannuation | Different product; needs professional advice. |
| GST calculation | Needs its own design and tax advice. v1 invoices do not calculate GST. |
| Currency conversion | One currency per group. |
| Native mobile apps | Planned after the web app ([roadmap](../planning/roadmap.md)). The web app works on phones. |

## How we'll know it works

- The founder uses it for all of their own employer invoicing for two months in a row, with no manual fixes to PDFs.
- A house of three or more people closes a month and settles up in under five minutes.
- The nightly check finds zero [ledger invariant](../architecture/ledger.md#invariants) violations in production.
