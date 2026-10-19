# User flows

Step-by-step journeys through the product. Each step names the function route it uses ([Functions API](../architecture/functions-api.md)), so frontend and backend agents build the same thing.

## 1. First login

1. The user signs up with an email and verifies it (Appwrite Auth).
2. The app calls `identity POST /bootstrap`. This creates their **person**, **profile** and **personal group**. It is safe to call on every login.
3. If records were already made for their email (for example a friend lent them money), `identity POST /claim` links those records to the new account. The user sees that history straight away.
4. The user lands on the dashboard.

## 2. Set up an employer with a weekly shift

1. **Groups → New → Employer.** The user enters the employer's name and billing email(s), the default rate ($25/h), the invoice cycle (monthly) and payment terms (14 days). → `groups POST /groups`.
2. **Add schedule:** every Thursday, 09:00, 5 hours, $25/h, starting 1 Oct 2026, skip public holidays (NSW). → `scheduler POST /schedules`.
3. The calendar immediately shows dashed shifts for the next 8 weeks. Public holidays are left out.

## 3. A normal Thursday, extra hours, or a missed day

- **Normal day:** the user does nothing. After the day ends in the group's timezone, the scheduler posts the shift (schedule setting `autoPost`).
- **Worked 2 extra hours:** the user opens the shift and changes 5h to 7h → `ledger PATCH /transactions/{id}`. The occurrence is marked `overridden`, so later schedule changes won't touch it.
- **Extra hours at a different rate:** add a second shift on the same day → `ledger POST /transactions`.
- **Didn't go:** void the shift with a reason → `ledger POST /transactions/{id}/void`. The voided row stays, so the scheduler never re-creates it.
- **Unplanned day:** tap **Start** on the Today screen (`ledger POST /timer/start`), then **Stop** (`ledger POST /timer/stop`).

## 4. Employer expenses and payments

| What happened | User picks | Effect on balance |
| --- | --- | --- |
| Paid $40 for their supplies with your own money | Expense → *I paid for them* | They owe you $40 more |
| Bought $120 of supplies on their card | Expense → *Bought on their card for work* | None, but listed on the invoice for transparency |
| Bought something personal on their card | Expense → *Personal, on their card* | They owe you less |
| They paid you $500 | Payment received | They owe you $500 less |

## 5. Month-end invoice

1. Just after the period ends (06:00 local time on 1 Nov), the statements job creates a **draft** invoice for October.
2. The user gets an email ("Your October invoice for Acme is ready"), opens the draft and checks it. They can still add or fix transactions; the draft is recalculated each time it is opened.
3. **Finalize & send** → `statements POST /statements/{id}/finalize`. This locks the transactions, gives the invoice its number, makes the PDF and emails the employer.
4. A mistake found later is fixed with an **adjustment** transaction, which appears on the next invoice. Sent invoices never change.

## 6. Create a house and add a bill

1. **Groups → New → House**, then add housemates by phone or email → `groups POST /groups/{id}/members`. Optionally send invites → `identity POST /invites`.
2. Alice adds the electricity bill: $270, period 1 Jul–30 Sep, due 15 Oct, not paid yet → `ledger POST /transactions` with `kind: bill`, status `due`.
3. Alice pays it on 10 Oct and marks it paid → `ledger POST /transactions/{id}/post`, with payer Alice.
4. The default split is **days present**. Cara moved in on 1 Aug, so she pays for 61 of the 92 days.

## 7. Itemised grocery receipt

1. Bob photographs the receipt; the app compresses the image and uploads it to the `receipts` bucket.
2. Bob adds the items: milk $4 (everyone), bread $5 (everyone), beer $20 (Bob only), discount −$2 (everyone).
3. `ledger POST /transactions` with `items`. Each person's share is the sum of their parts of each item.

## 8. Settle up and monthly divide

1. The house screen shows balances and suggested transfers, for example "Cara → Alice $45.20".
2. Cara pays Alice by bank transfer outside the app, then taps **Record payment** → `ledger POST /transactions` with `kind: payment`.
3. At month end the statements job drafts the **monthly divide**. An admin finalizes it, which locks the month, makes the PDF and emails everyone.

## 9. Lend to a friend who isn't registered

1. **People → New lend & borrow**, enter "Sam" and Sam's mobile number → `groups POST /groups` with `type: pair` and a counterpart.
2. Record "Lent $50" → `ledger POST /transactions` with `kind: loan`.
3. Months later Sam signs up with that number and verifies it. `identity POST /claim` links Sam's account to the placeholder. Sam sees the pair group and the $50.
4. If Sam already had an account when added, the pair group shows in Sam's app as pending, and Sam joins it there. Until Sam joins, the lender can't tell which case it is.

## 10. Personal rent with a reminder

1. Personal → **New recurring bill**: description "Rent", category `rent`, $400, weekly on Monday → `scheduler POST /schedules` with `kind: bill`. (There is no payee field; the landlord isn't a member of the personal group.)
2. The scheduler creates each week's bill as `due`. A reminder email goes out 2 days before.
3. The user taps **Mark paid** → `ledger POST /transactions/{id}/post`. If autopay is on in the schedule (`autoPost`), it is posted automatically on the due date.
