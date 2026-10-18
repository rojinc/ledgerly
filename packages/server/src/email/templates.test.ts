import { type LocalDate, parseLocalDate } from '@ledgerly/core/dates/local-date'
import { describe, expect, it } from 'vitest'
import {
  type EmailContent,
  invoiceEmail,
  shiftToConfirmEmail,
  statementReadyEmail,
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

  it('gives the year once for a period that crosses into a new year', () => {
    const content = invoiceEmail({
      ...invoice,
      periodStart: day('2026-12-28'),
      periodEnd: day('2027-01-03'),
    })
    expect(content.text).toContain('for 28 December – 3 January 2027.')
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
  it.each(['2026-10-16', 'not a time', '2026-10-16T25:00:00Z'])('refuses %j', (startedAt) => {
    expect(() => timer(startedAt)).toThrow('startedAt must be an ISO date and time')
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
})
