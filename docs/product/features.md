# Features

Every feature has an ID (`F-xx`). GitHub issues refer to these IDs. The milestone column says when it ships; see the [roadmap](../planning/roadmap.md).

## Accounts and profile

| ID | Feature | Milestone |
| --- | --- | --- |
| F-01 | Sign up and log in with email + password or email code (OTP). Google sign-in later. | M0 |
| F-02 | Email verification. Required before you can invite people or claim records made with your email. | M0 |
| F-03 | Profile: display name, timezone, holiday region (e.g. `AU-NSW`), default currency. | M1 |
| F-04 | Business details printed on invoices: business name, ABN, address, contact email, bank details (account name, BSB, account number) and PayID. | M1 |
| F-05 | Phone verification (optional). Needed to claim records made with your phone number. | M3 |
| F-06 | Delete account and export your data. | M4 |

## Groups (shared by every module)

| ID | Feature | Milestone |
| --- | --- | --- |
| F-10 | Create a group of a type (`personal`, `house`, `employer`, `pair`) with name, currency and timezone. Defaults come from the profile. | M1 |
| F-11 | Members: add by email, phone or existing account. Each group keeps its own display name for a person. Roles: admin, member, viewer. | M1 |
| F-12 | People who haven't joined, registered or not, can be members and show as "not joined". Both cases look the same. | M1 |
| F-13 | Join and leave dates for members (moving in and out). | M3 |
| F-14 | Activity feed: who added, changed or voided what, and when. | M3 |
| F-15 | Archive a group, which makes it read-only. | M2 |

## Employer

| ID | Feature | Milestone |
| --- | --- | --- |
| F-20 | An employer group holds you and the employer, who is usually a placeholder with one or more billing emails. | M1 |
| F-21 | Shifts: date, start and end time or a number of minutes, break minutes, rate and note. Amount = minutes × rate, rounded to the cent. | M1 |
| F-22 | Schedules: for example "every Thursday, 5h at $25, from 2 Oct until I stop". You can skip public holidays for the region, skip specific dates, pause or end. | M1 |
| F-23 | Automatic entries: scheduled shifts appear on the calendar ahead of time. After the day passes they are confirmed automatically if the schedule has auto-post on. Cancelled shifts are skipped; changed ones are confirmed with your changes. | M1 |
| F-24 | Timer: start and stop to record a shift live. You get a reminder if it has been running more than 12 hours. | M1 |
| F-25 | Extra hours: change the minutes, or add another shift on the same day at a different rate. | M1 |
| F-26 | Expenses with presets: *I paid for them* (they owe you), *bought on their card for work* (shown for information only), *personal purchase on their card or a cash advance* (deducted from what they owe). | M1 |
| F-27 | Record payments received. | M1 |
| F-28 | Balance: what the employer owes you right now. | M1 |
| F-29 | Invoices on a weekly, fortnightly or monthly cycle. A draft is created at the end of each period; you review it, then finalize and email the PDF. Optional auto-send. Numbering such as `INV-0001` per user. Payment terms. | M1 |
| F-30 | Rate changes only affect future shifts. Past shifts keep their rate. | M1 |

## House

| ID | Feature | Milestone |
| --- | --- | --- |
| F-40 | House group. Invite housemates by email or phone. Move-in and move-out dates. | M3 |
| F-41 | Expenses: one or more payers; split equally, by exact amounts, by percentages or by weights. | M3 |
| F-42 | Bills with a billing period and due date. Default split: the days each person lived there during the period. | M3 |
| F-43 | Itemised receipts: each item has its own split (milk for everyone, Bob's beer for Bob only). | M3 |
| F-44 | Attach receipt photos or PDFs to any transaction. | M3 |
| F-45 | Recurring bills and expenses (rent, internet). | M3 |
| F-46 | Balances and settle-up suggestions using the fewest transfers. Record a settlement payment. | M3 |
| F-47 | Monthly divide: a statement for the month showing each person's paid, share and net, plus suggested transfers. Comes with a PDF and locks the month. | M3 |
| F-48 | Anyone can add transactions. You can edit your own; admins can edit everyone's; nobody can edit a locked month. | M3 |

## Personal

| ID | Feature | Milestone |
| --- | --- | --- |
| F-50 | A personal group is created automatically for every user. | M1 |
| F-51 | Bills with due dates and paid/unpaid status, including recurring ones (weekly rent, monthly phone). | M2 |
| F-52 | Email reminders before a bill is due. | M2 |
| F-53 | Spending overview by category and month, including your share from every group. | M2 |
| F-54 | Income overview: payments from employers plus personal income entries. | M2 |

## Lend and borrow

| ID | Feature | Milestone |
| --- | --- | --- |
| F-60 | A pair group with one other person, registered or added by email or phone. | M2 |
| F-61 | Lend, borrow and repay, including partial repayments. | M2 |
| F-62 | Balance with that person. | M2 |
| F-63 | "Send a reminder" email or SMS, to an address the sender types for that person, sent the same way whether or not they have an account. | M4 |

## Calendar, history and export (every module)

| ID | Feature | Milestone |
| --- | --- | --- |
| F-70 | Calendar month view of all your transactions, coloured by group. Dashed means scheduled or due; solid means posted. | M1 |
| F-71 | History list with filters (group, kind, date range, category, person) and a description search. | M1 |
| F-72 | CSV export per group and date range. | M4 |

## Reports and notifications

| ID | Feature | Milestone |
| --- | --- | --- |
| F-80 | Summary email every week, fortnight or month (user setting). | M2 |
| F-81 | Notifications for joined members: statement ready, bill due, shift to confirm, someone changed a transaction you're in. Being added to a group shows only in the app's pending list, never by email, so nobody can tell from it who has an account. | M2–M3 |
| F-82 | Work-hours cap alert. The user enters their own limit per week or fortnight; no visa or award rules are built in. | M4 |

## Later (not v1)

- Receipt scanning (photo → line items) with an AI vision model.
- Mobile apps (Expo / React Native).
- Employer portal, where an employer logs in to see statements.
- Subscription billing for the SaaS.
- More currencies and countries.
- Per-friend totals across all groups.
