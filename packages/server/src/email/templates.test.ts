import { type LocalDate, parseLocalDate } from '@ledgerly/core/dates/local-date'
import { describe, expect, it } from 'vitest'
import {
  divideEmail,
  type EmailContent,
  invoiceEmail,
  passwordChangedEmail,
  reminderEmail,
  shiftToConfirmEmail,
  statementReadyEmail,
  summaryEmail,
  timerRunningEmail,
} from './templates'

const day = (text: string): LocalDate => parseLocalDate(text)

const invoice = {
  issuerName: 'Sam Lee',
  displayNumber: 'INV-0010',
  periodStart: day('2026-10-01'),
  periodEnd: day('2026-10-31'),
  balanceDueCents: 123_450,
  currency: 'AUD',
  dueOn: day('2026-11-14'),
  pdf: new Uint8Array([37, 80, 68, 70]),
}

// Every template: one-line subject, the same words in both parts, no images.
function expectWellFormed(content: EmailContent) {
  expect(content.subject).not.toMatch(/[\r\n]/)
  expect(content.html).toMatch(/^<!doctype html>/)
  expect(content.html).not.toMatch(/<img|<script/i)
  expect(content.text).not.toMatch(/<[a-z]/i)
  expect(content.text).toContain('Sent with Ledgerly.')
}

describe('statementReadyEmail', () => {
  const ready = (type: 'invoice' | 'divide', start: string, end: string) =>
    statementReadyEmail({
      type,
      groupName: 'Acme',
      periodStart: day(start),
      periodEnd: day(end),
      url: 'https://app.example/statements/stmt-1',
    })

  it('names a whole month, as in statements.md', () => {
    const content = ready('invoice', '2026-10-01', '2026-10-31')
    expectWellFormed(content)
    expect(content.subject).toBe('Your October invoice for Acme is ready to review')
    expect(content.text).toContain('Your October invoice for Acme has been drafted.')
    expect(content.text).toContain('Review the invoice: https://app.example/statements/stmt-1')
    expect(content.html).toContain(
      '<a href="https://app.example/statements/stmt-1">Review the invoice</a>',
    )
  })

  it.each([
    ['2026-10-01', '2026-10-07', 'Your 1–7 October invoice for Acme is ready to review'],
    [
      '2026-09-28',
      '2026-10-11',
      'Your 28 September – 11 October invoice for Acme is ready to review',
    ],
    // A whole February, leap year or not.
    ['2028-02-01', '2028-02-29', 'Your February invoice for Acme is ready to review'],
    // Starts on the 1st but stops before the month ends.
    ['2026-10-01', '2026-10-14', 'Your 1–14 October invoice for Acme is ready to review'],
    // One day, for example a reissue.
    ['2026-10-16', '2026-10-16', 'Your 16 October invoice for Acme is ready to review'],
    // Across a new year, or longer than a year: both years (#125).
    [
      '2026-12-28',
      '2027-01-03',
      'Your 28 December 2026 – 3 January 2027 invoice for Acme is ready to review',
    ],
    [
      '2025-07-01',
      '2026-10-31',
      'Your 1 July 2025 – 31 October 2026 invoice for Acme is ready to review',
    ],
    [
      '2024-01-01',
      '2026-12-31',
      'Your 1 January 2024 – 31 December 2026 invoice for Acme is ready to review',
    ],
  ])('names the period %s to %s', (start, end, subject) => {
    expect(ready('invoice', start, end).subject).toBe(subject)
  })

  it('calls a house statement a divide', () => {
    const content = ready('divide', '2026-10-01', '2026-10-31')
    expect(content.subject).toBe('Your October divide for Acme is ready to review')
    expect(content.text).toContain('Review the divide: ')
  })
})

describe('invoiceEmail', () => {
  it('attaches the PDF and states the amount and due date', () => {
    const content = invoiceEmail(invoice)
    expectWellFormed(content)
    expect(content.subject).toBe('Invoice INV-0010 from Sam Lee')
    expect(content.text).toContain(
      'Please find attached invoice INV-0010 from Sam Lee for October 2026.',
    )
    expect(content.text).toContain('$1,234.50 is due by 14 November 2026.')
    expect(content.text).toContain('reply to this email')
    expect(content.attachments).toEqual([{ filename: 'INV-0010.pdf', content: invoice.pdf }])
  })

  it('gives both years, once each, for a period that crosses into a new year', () => {
    const content = invoiceEmail({
      ...invoice,
      periodStart: day('2026-12-28'),
      periodEnd: day('2027-01-03'),
    })
    expect(content.text).toContain('for 28 December 2026 – 3 January 2027.')
  })

  it('gives the year once for a period within one year', () => {
    const content = invoiceEmail({
      ...invoice,
      periodStart: day('2026-09-28'),
      periodEnd: day('2026-10-11'),
    })
    expect(content.text).toContain('for 28 September – 11 October 2026.')
  })

  it.each([
    [0, 'There is nothing to pay this time.'],
    // The employer paid more than they owed.
    [-2_000, 'You have a credit of $20.00, so there is nothing to pay.'],
  ])('says there is nothing to pay when the balance is %i', (cents, line) => {
    const content = invoiceEmail({ ...invoice, balanceDueCents: cents })
    expect(content.text).not.toContain('is due by')
    expect(content.text).toContain(line)
  })

  it('formats other currencies by their own decimals', () => {
    const content = invoiceEmail({ ...invoice, currency: 'JPY', balanceDueCents: 5000 })
    // Intl puts a no-break space after the currency code.
    expect(content.text).toMatch(/JPY\s5,000 is due by/)
  })

  it('keeps the attachment name to safe characters', () => {
    const content = invoiceEmail({ ...invoice, displayNumber: 'A/B "0010"' })
    expect(content.attachments?.[0]?.filename).toBe('A-B--0010-.pdf')
  })
})

describe('divideEmail', () => {
  // Cara in the golden divide (core's snapshot test): she owes $67.22 in all.
  const cara = {
    groupName: '12 Smith St',
    periodStart: day('2026-10-01'),
    periodEnd: day('2026-10-31'),
    currency: 'AUD',
    closingCents: -6722,
    pays: [
      { name: 'Alice', cents: 6422 },
      { name: 'Erin', cents: 300 },
    ],
    receives: [],
    url: 'https://app.example/groups/grp_house/statements/st1',
    pdf: new Uint8Array([37, 80, 68, 70]),
  }

  it('says where they stand, then their own transfers, then the link, with the PDF', () => {
    const content = divideEmail(cara)
    expectWellFormed(content)
    expect(content.subject).toBe('Your October divide for 12 Smith St')
    expect(content.text.split('\n\n')).toEqual([
      "Here's the October divide for 12 Smith St. The PDF is attached.",
      'You owe $67.22.',
      'Pay Alice $64.22.',
      'Pay Erin $3.00.',
      'Open the divide: https://app.example/groups/grp_house/statements/st1',
      '--\nSent with Ledgerly.',
    ])
    expect(content.attachments).toEqual([{ filename: 'divide-2026-10-31.pdf', content: cara.pdf }])
  })

  it('tells someone who is owed who pays them', () => {
    const erin = { ...cara, closingCents: 300, pays: [], receives: [{ name: 'Cara', cents: 300 }] }
    const content = divideEmail(erin)
    expect(content.text).toContain("You're owed $3.00.\n\nCara pays you $3.00.")
    expect(content.text).not.toContain('Pay ')
  })

  it('tells someone who is square that they are settled up', () => {
    const content = divideEmail({ ...cara, closingCents: 0, pays: [] })
    expect(content.text).toContain("You're settled up.")
    expect(content.text).not.toMatch(/Pay |pays you/)
  })

  it('names both years for a period across a new year', () => {
    const content = divideEmail({
      ...cara,
      periodStart: day('2026-12-15'),
      periodEnd: day('2027-01-14'),
    })
    expect(content.subject).toBe('Your 15 December 2026 – 14 January 2027 divide for 12 Smith St')
    expect(content.attachments?.[0]?.filename).toBe('divide-2027-01-14.pdf')
  })

  it('escapes names in the HTML and refuses a link that isn’t http(s)', () => {
    const content = divideEmail({
      ...cara,
      groupName: '<b>House</b>',
      pays: [{ name: 'Al & "Co"', cents: 100 }],
    })
    expect(content.html).toContain('&lt;b&gt;House&lt;/b&gt;')
    expect(content.html).toContain('Pay Al &amp; &quot;Co&quot; $1.00.')
    expect(() => divideEmail({ ...cara, url: 'javascript:alert(1)' })).toThrow('http(s)')
  })
})

describe('shiftToConfirmEmail', () => {
  it('names the day of the shift', () => {
    const content = shiftToConfirmEmail({
      groupName: 'Acme',
      date: day('2026-10-15'),
      url: 'https://app.example/groups/g1/transactions/t1',
    })
    expectWellFormed(content)
    expect(content.subject).toBe('Confirm your shift on Thursday 15 October')
    expect(content.text).toContain(
      "Your shift in Acme on Thursday 15 October hasn't been confirmed yet.",
    )
    expect(content.text).toContain(
      'Confirm the shift: https://app.example/groups/g1/transactions/t1',
    )
  })
})

describe('timerRunningEmail', () => {
  const timer = (startedAt: string, timeZone = 'Australia/Sydney') =>
    timerRunningEmail({
      groupName: 'Acme',
      startedAt,
      timeZone,
      url: 'https://app.example/groups/g1/transactions/t1',
    })

  it("shows the start on the group's wall clock", () => {
    // 21:02 UTC is 08:02 the next morning in Sydney (AEDT, UTC+11).
    const content = timer('2026-10-15T21:02:00.000Z')
    expectWellFormed(content)
    expect(content.subject).toBe('Your timer is still running')
    expect(content.text).toContain(
      'Your timer in Acme has been running since Friday 16 October, 8:02 am.',
    )
    expect(content.text).toContain('Open the timer: https://app.example/groups/g1/transactions/t1')
  })

  it.each([
    ['2026-10-15T13:00:00.000Z', 'Friday 16 October, 12:00 am'],
    ['2026-10-16T01:30:00.000Z', 'Friday 16 October, 12:30 pm'],
    ['2026-10-16T08:45:00.000Z', 'Friday 16 October, 7:45 pm'],
  ])('writes %s as %s', (startedAt, since) => {
    expect(timer(startedAt).text).toContain(`running since ${since}.`)
  })

  it('uses the given timezone, not the machine one', () => {
    expect(timer('2026-10-15T21:02:00.000Z', 'Europe/London').text).toContain(
      'running since Thursday 15 October, 10:02 pm.',
    )
  })

  // A plain date would otherwise show as 11:00 am, a time nobody started at.
  it('reads an offset as well as Z', () => {
    expect(timer('2026-10-16T08:02:00.000+11:00').text).toContain(
      'running since Friday 16 October, 8:02 am.',
    )
  })

  it.each([
    '2026-10-16',
    'not a time',
    '2026-10-16T25:00:00Z',
    // No Z or offset: Date would read it in the machine's timezone.
    '2026-10-16T10:00',
    '2026-10-16T10:00:00.000',
  ])('refuses %j', (startedAt) => {
    expect(() => timer(startedAt)).toThrow('startedAt must be an ISO date and time')
  })
})

describe('passwordChangedEmail', () => {
  const notice = (changedAt: string, timeZone = 'Australia/Sydney') =>
    passwordChangedEmail({ changedAt, timeZone, url: 'https://app.example/login' })

  it("says when, on the wall clock of the profile's time zone, and links only to the sign-in page", () => {
    // 21:02 UTC is 08:02 the next morning in Sydney (AEDT, UTC+11).
    const content = notice('2026-10-15T21:02:00.000Z')
    expectWellFormed(content)
    expect(content.subject).toBe('Your Ledgerly password was changed')
    expect(content.text).toContain(
      'The password for your Ledgerly account was set or changed on Friday 16 October, 8:02 am (Australia/Sydney time).',
    )
    expect(content.text).toContain("If this wasn't you, reset your password now.")
    expect(content.text).toContain('Go to Ledgerly: https://app.example/login')
    expect(content.html.match(/href=/g)).toHaveLength(1)
  })

  it('names UTC when there is no profile', () => {
    expect(notice('2026-10-15T21:02:00.000Z', 'UTC').text).toContain(
      'on Thursday 15 October, 9:02 pm (UTC time).',
    )
  })

  it.each(['2026-10-16', 'not a time', '2026-10-16T10:00:00.000'])('refuses %j', (changedAt) => {
    expect(() => notice(changedAt)).toThrow('changedAt must be an ISO date and time')
  })
})

describe('summaryEmail', () => {
  const report = (currency: string, extra: object = {}) => ({
    currency,
    spendingCents: 0,
    spendingByCategory: {},
    earningsCents: 0,
    moneyReceivedCents: 0,
    incomeCents: 0,
    paidOutCents: 0,
    personalIncomeCents: 0,
    ...extra,
  })
  const summary = (input: Partial<Parameters<typeof summaryEmail>[0]> = {}) =>
    summaryEmail({
      periodStart: day('2026-10-12'),
      periodEnd: day('2026-10-18'),
      reports: [],
      balances: [],
      url: 'https://app.example/',
      profileUrl: 'https://app.example/profile',
      ...input,
    })

  it('gives spending by category, biggest first, income and balances', () => {
    const content = summary({
      reports: [
        report('AUD', {
          spendingCents: 12_345,
          spendingByCategory: { food: 2_345, groceries: 8_000, none: 2_000 },
          incomeCents: 150_000,
        }),
      ],
      balances: [
        { groupName: 'Elm St', currency: 'AUD', cents: -2_050 },
        { groupName: 'Acme', currency: 'AUD', cents: 50_000 },
        { groupName: 'Pine Rd', currency: 'AUD', cents: -9_000 },
        { groupName: 'Birch Ln', currency: 'AUD', cents: 50_000 },
      ],
    })
    expectWellFormed(content)
    expect(content.subject).toBe('Your 12–18 October summary')
    expect(content.text).toBe(
      [
        'Here is your summary for 12–18 October.',
        'You spent $123.45.',
        '- Groceries: $80.00\n- Food: $23.45\n- No category: $20.00',
        'Your income was $1,500.00.',
        'Owed to you:',
        '- Acme: $500.00\n- Birch Ln: $500.00',
        'You owe:',
        '- Pine Rd: $90.00\n- Elm St: $20.50',
        'You can turn these emails off, or change how often they come, in your profile.',
        'Open Ledgerly: https://app.example/',
        'Change your summary emails: https://app.example/profile',
        '--\nSent with Ledgerly.',
      ].join('\n\n'),
    )
    expect(content.html).toContain(
      '<ul><li>Groceries: $80.00</li><li>Food: $23.45</li><li>No category: $20.00</li></ul>',
    )
    expect(content.html).toContain(
      '<a href="https://app.example/profile">Change your summary emails</a>',
    )
  })

  it('names a whole month, and gives refunds as negative spending', () => {
    const content = summary({
      periodStart: day('2026-10-01'),
      periodEnd: day('2026-10-31'),
      reports: [report('AUD', { spendingCents: -500, spendingByCategory: { household: -500 } })],
    })
    expect(content.subject).toBe('Your October summary')
    expect(content.text).toContain('You spent -$5.00.')
    expect(content.text).toContain('- Household: -$5.00')
    expect(content.text).not.toContain('Owed to you')
    expect(content.text).not.toContain('You owe')
  })

  it('gives each currency its own section, with only what it has', () => {
    const content = summary({
      reports: [report('AUD', { spendingCents: 1_000, spendingByCategory: { food: 1_000 } })],
      balances: [{ groupName: 'Bob', currency: 'USD', cents: 2_000 }],
    })
    const text = content.text
    expect(text.indexOf('In AUD:')).toBeLessThan(text.indexOf('You spent $10.00.'))
    expect(text.indexOf('You spent $10.00.')).toBeLessThan(text.indexOf('In USD:'))
    // USD has a balance but no shares in the period, so no spending or income line.
    expect(text.slice(text.indexOf('In USD:'))).not.toContain('You spent')
    expect(text).toMatch(/In USD:\n\nOwed to you:\n\n- Bob: USD\s20\.00/)
    expect(text.match(/Your income was/g)).toHaveLength(1)
  })

  it('orders currencies, and categories and groups of the same size by name', () => {
    const content = summary({
      reports: [
        report('USD', { spendingCents: 200, spendingByCategory: { food: 100, bills: 100 } }),
        report('AUD'),
      ],
      balances: [
        { groupName: 'Pine Rd', currency: 'AUD', cents: 500 },
        { groupName: 'Elm St', currency: 'AUD', cents: 500 },
      ],
    })
    const text = content.text
    expect(text.indexOf('In AUD:')).toBeLessThan(text.indexOf('In USD:'))
    expect(text).toMatch(/- Bills: USD\s1\.00\n- Food: USD\s1\.00/)
    expect(text).toContain('- Elm St: $5.00\n- Pine Rd: $5.00')
  })

  it('leaves out categories and balances at 0, and empty lists', () => {
    const content = summary({
      reports: [report('AUD', { incomeCents: 100, spendingByCategory: { groceries: 0 } })],
      balances: [{ groupName: 'Elm St', currency: 'AUD', cents: 0 }],
    })
    expect(content.text).toContain('You spent $0.00.\n\nYour income was $1.00.')
    expect(content.text).not.toMatch(/Groceries|Elm St|Owed to you|You owe/)
    expect(content.html).not.toContain('<ul>')
  })

  it('escapes group names in the HTML', () => {
    const content = summary({
      balances: [{ groupName: '<b>Tom & Jo</b>', currency: 'AUD', cents: 100 }],
    })
    expect(content.html).toContain('<li>&lt;b&gt;Tom &amp; Jo&lt;/b&gt;: $1.00</li>')
    expect(content.html).not.toContain('<b>')
  })
})

describe('user-typed text', () => {
  it('is escaped in the HTML and kept on one line in the subject', () => {
    const content = statementReadyEmail({
      type: 'invoice',
      groupName: `<b>Tom & Jo's</b>\r\nBcc: x@example.com "Ltd"`,
      periodStart: day('2026-10-01'),
      periodEnd: day('2026-10-31'),
      url: 'https://app.example/s?a=1&b="2"',
    })
    expect(content.subject).toBe(
      `Your October invoice for <b>Tom & Jo's</b> Bcc: x@example.com "Ltd" is ready to review`,
    )
    expect(content.html).toContain(
      'for &lt;b&gt;Tom &amp; Jo&#39;s&lt;/b&gt;\r\nBcc: x@example.com &quot;Ltd&quot; has been drafted.',
    )
    expect(content.html).not.toContain('<b>')
    expect(content.html).toContain('href="https://app.example/s?a=1&amp;b=&quot;2&quot;"')
  })

  it.each(['javascript:alert(1)', 'data:text/html,hi', '/relative/path'])(
    'refuses a link to %s',
    (url) => {
      expect(() =>
        shiftToConfirmEmail({ groupName: 'Acme', date: day('2026-10-15'), url }),
      ).toThrow('Email links must be http(s)')
    },
  )

  it('checks every link, not only the first', () => {
    expect(() =>
      summaryEmail({
        periodStart: day('2026-10-12'),
        periodEnd: day('2026-10-18'),
        reports: [],
        balances: [],
        url: 'https://app.example/',
        profileUrl: 'javascript:alert(1)',
      }),
    ).toThrow('Email links must be http(s)')
  })
})

describe('reminderEmail', () => {
  const reminder = (senderName = 'Sam', amountCents = 4550, currency = 'AUD') =>
    reminderEmail({ senderName, amountCents, currency, url: 'https://app.example' })

  it('has a fixed subject, names the sender and the amount, and links only to the app', () => {
    const content = reminder()
    expectWellFormed(content)
    expect(content.subject).toBe('You have a payment reminder')
    expect(content.text).toContain('Sam sent you a reminder that you owe them $45.50.')
    expect(content.text).toContain("If you've already paid, let them know so they can record it.")
    expect(content.text).toContain('Open Ledgerly: https://app.example')
    expect(content.html.match(/<a /g)).toHaveLength(1)
  })

  it('escapes the name, keeps it out of the subject, and uses the currency’s digits', () => {
    const content = reminder('<b>Sam</b> & co', 1234, 'JPY')
    expect(content.subject).toBe('You have a payment reminder')
    expect(content.html).toContain('&lt;b&gt;Sam&lt;/b&gt; &amp; co sent you a reminder')
    expect(content.html).not.toContain('<b>Sam')
    expect(content.text).toMatch(/owe them JPY\s1,234\./)
  })

  it('writes a balance past the amount cap', () => {
    expect(reminder('Sam', 20_000_000_000).text).toContain('owe them $200,000,000.00.')
  })

  it('cuts a name past 40 characters, by character', () => {
    expect(reminder('a'.repeat(40)).text).toContain(`${'a'.repeat(40)} sent you`)
    expect(reminder('a'.repeat(41)).text).toContain(`${'a'.repeat(39)}… sent you`)
    expect(reminder('𠀀'.repeat(41)).text).toContain(`${'𠀀'.repeat(39)}… sent you`)
    // A family emoji is 5 code points but one character, and isn't split.
    const family = '👩‍👩‍👧'
    expect(reminder(`${'a'.repeat(38)}${family}bb`).text).toContain(
      `${'a'.repeat(38)}${family}… sent you`,
    )
    expect(reminder(`${'a'.repeat(39)}${family}`).text).toContain(`${'a'.repeat(39)}${family} sent`)
  })

  it('puts a name with line breaks on one line', () => {
    const content = reminder('Sam\n\nPay at https://evil.example\t now')
    expect(content.text).toContain('Sam Pay at https://evil.example now sent you a reminder')
    expect(content.html).toContain('Sam Pay at https://evil.example now sent you a reminder')
  })
})
