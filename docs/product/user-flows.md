# User flows

Step-by-step journeys through the product. Each step names the function route it uses ([Functions API](../architecture/functions-api.md)), so frontend and backend agents build the same thing.

## 1. First login

1. The user signs up with an email and verifies it (Appwrite Auth).
2. The app calls `identity POST /bootstrap`. This creates their **person**, **profile** and **personal group**. It is safe to call on every login.
3. If records were already made for their email (for example a friend lent them money), `identity POST /claim` links those records to the new account. The user sees that history straight away.
4. The user lands on the dashboard. Until they've recorded something, it shows a getting-started guide (F-07): first **What do you want to track first?** (an employer, a lend & borrow, or bills), with any groups waiting for them to join and the time zone, holiday region and currency bootstrap guessed; then, once they've joined another group, **Record your first entry** with a link for each group they can add to. It goes for good once any of their groups has a transaction, and that device stops checking. **Hide** removes the guide on that device, but not the groups waiting for them to join.

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

To fix a posted entry, the worker opens it and taps **Edit**, which shows the same choices → `ledger PATCH /transactions/{id}`. An expense can switch to another expense choice, and a payment stays a payment. An entry that matches none of the choices says so and has no Edit: void it and add it again. An entry with items has no Edit yet.

## 5. Month-end invoice

1. Just after the period ends (06:00 local time on 1 Nov), the statements job creates a **draft** invoice for October.
2. The user gets an email ("Your October invoice for Acme is ready"), opens the draft and checks it. They can still add or fix transactions; the draft is recalculated each time it is opened.
3. **Finalize & send** → `statements POST /statements/{id}/finalize`. This locks the transactions, gives the invoice its number, makes the PDF and emails the employer.
4. A mistake found later is fixed with an **adjustment** transaction, which appears on the next invoice. Sent invoices never change. On the final invoice, an admin taps **Correct with an adjustment** (or, on the add page, *Correct a final invoice with an adjustment*): who is owed more, who owes more, the amount, the date and the reason, which the next invoice shows → `ledger POST /transactions` with `kind: adjustment`. The person owed more gives the amount and the one who owes more receives it, so their balances move by it and the shares balance. A house corrects a final divide the same way.

To bill before the period ends, or with no regular invoices at all, an admin uses **Close period now…** → `statements POST /statements/close`. That drafts the invoice up to the chosen day (default: today). With a regular cycle, the job later drafts only the rest of the period.

## 6. Create a house and add a bill

1. **Groups → New → House**, then add housemates by phone or email → `groups POST /groups/{id}/members`. Optionally send invites → `identity POST /invites`.
2. Alice adds the electricity bill: $270, period 1 Jul–30 Sep, due 15 Oct, not paid yet → `ledger POST /transactions` with `kind: bill`, status `due`.
3. Alice pays it on 10 Oct and marks it paid → `ledger POST /transactions/{id}/post`, with payer Alice.
4. The default split is **days present**. Cara moved in on 1 Aug, so she pays for 61 of the 92 days.

**Recurring house bills and expenses** ([#403](https://github.com/rojinc/ledgerly/issues/403)): on the house's Bills page, an admin or member taps **New recurring**. They choose a bill (due on each date until someone marks it paid, or paid by autopay) or an expense (added on each date as already paid), then the amount, who pays it, and the split, with the repeat and the first date. The split is either everyone living there on each date, equally, or equally between the people ticked → `scheduler POST /schedules`, with the template's `payers` and, for ticked people, an `equal` split. A recurring expense always posts itself (`autoPost`), and starts today at the earliest, since nothing else posts its occurrences. The Bills page lists them, and their creator or an admin can **Stop** one.

A posted house expense is fixed the same way as an employer entry: its creator or an admin opens it and taps **Edit**, which shows the house expense form filled in → `ledger PATCH /transactions/{id}`. Who paid, the split and the people sharing it can all change; a new date doesn't change who shares it. One the form can't show has no Edit: void it and add it again.

## 7. Itemised grocery receipt

1. Bob photographs the receipt; the app compresses the image and uploads it to the `receipts` bucket.
2. Bob adds the items: milk $4 (everyone), bread $5 (everyone), beer $20 (Bob only), discount −$2 (everyone).
3. `ledger POST /transactions` with `items`. Each person's share is the sum of their parts of each item.
4. To fix it, Bob opens it and taps **Edit**, which shows the same items, filled in → `ledger PATCH /transactions/{id}` with every item. Items can be added, removed or changed, and so can who each one is for. It stays itemised, and whether it's a refund follows the items' sum, as when it was added.

## 8. Settle up and monthly divide

1. The house screen shows balances and suggested transfers, for example "Cara → Alice $45.20".
2. Cara pays Alice by bank transfer outside the app, then taps **Record payment** → `ledger POST /transactions` with `kind: payment`.
3. At month end the statements job drafts the **monthly divide**. An admin can also draft it sooner with **Close period now…**, for example when someone moves out. Any member can see the current period so far. An admin finalizes the divide, which locks its period, makes the PDF and emails everyone.

## 9. Lend to a friend who isn't registered

1. **People → New lend & borrow**, enter "Sam" and Sam's mobile number → `groups POST /groups` with `type: pair` and a counterpart.
2. Record "Lent $50" → `ledger POST /transactions` with `kind: loan`. To fix it later, open it and tap **Edit** → `ledger PATCH /transactions/{id}`. A loan can switch between lent and borrowed, and a repayment can change who paid back.
3. Months later Sam signs up with that number and verifies it. `identity POST /claim` links Sam's account to the placeholder. Sam sees the pair group and the $50.
4. If Sam already had an account when added, the pair group shows in Sam's app as pending, and Sam joins it there. Until Sam joins, the lender can't tell which case it is.
5. Under **Settings** on the pair's page, either person (both are admins) can **Change their name** → `groups PATCH /groups/{id}/members/{memberId}` with `{ displayName }`. The app shows a pair by the other person's name, so this is how it's renamed; for the lender, who made it, the group's own `name` (their label for Sam, which emails such as invites use) changes with it → `groups PATCH /groups/{id}` with `{ name }`. Until Sam joins, **Invite by email** sends Sam a link at an email address Sam was added with → `identity POST /invites` (here Sam was added by mobile only, so an invite waits for SMS, #40). **Archive group** makes it read-only → `groups POST /groups/{id}/archive`.

## 10. Personal rent with a reminder

1. Personal → **New recurring bill**: description "Rent", category `rent`, $400, weekly on Monday → `scheduler POST /schedules` with `kind: bill`. (There is no payee field; the landlord isn't a member of the personal group.)
2. The scheduler creates each week's bill as `due`. A reminder email goes out 2 days before.
3. The user taps **Mark paid** → `ledger POST /transactions/{id}/post`. If autopay is on in the schedule (`autoPost`), it is posted automatically on the due date.
