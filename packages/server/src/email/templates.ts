import { endOfMonth, type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { formatMoney } from '@ledgerly/core/money/format'
import type { Attachment } from './send-email'

/** What `sendEmail` needs apart from the addresses. */
export type EmailContent = {
  subject: string
  html: string
  text: string
  attachments?: Attachment[]
}

const LOCALE = 'en-AU'
// An ISO date and time with `Z` or an offset, as Appwrite stores datetimes.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * To the group admins when the statements job drafts a statement: "Your October invoice for
 * Acme is ready to review" (statements.md#1-draft).
 */
export function statementReadyEmail(input: {
  type: 'invoice' | 'divide'
  groupName: string
  periodStart: LocalDate
  periodEnd: LocalDate
  url: string
}): EmailContent {
  const period = periodLabel(input.periodStart, input.periodEnd)
  return message(
    `Your ${period} ${input.type} for ${input.groupName} is ready to review`,
    [
      `Your ${period} ${input.type} for ${input.groupName} has been drafted.`,
      'Check it before you finalize it. You can still add or fix transactions until then.',
    ],
    { label: `Review the ${input.type}`, url: input.url },
  )
}

/**
 * To the employer's billing emails, with the invoice PDF attached. Send it with `replyTo` set
 * to the worker's email, so "reply to this email" reaches them (statements.md#3-send-and-resend).
 */
export function invoiceEmail(input: {
  issuerName: string
  displayNumber: string
  periodStart: LocalDate
  periodEnd: LocalDate
  balanceDueCents: number
  currency: string
  dueOn: LocalDate
  pdf: Uint8Array
}): EmailContent {
  const amount = formatMoney(input.balanceDueCents, input.currency, LOCALE)
  const period = periodLabelWithYear(input.periodStart, input.periodEnd)
  return {
    ...message(`Invoice ${input.displayNumber} from ${input.issuerName}`, [
      'Hello,',
      `Please find attached invoice ${input.displayNumber} from ${input.issuerName} for ${period}.`,
      input.balanceDueCents > 0
        ? `${amount} is due by ${longDate(input.dueOn)}.`
        : nothingToPay(input.balanceDueCents, input.currency),
      'If you have any questions, reply to this email.',
    ]),
    // The prefix is user-typed; keep the file name to characters every mail client accepts.
    attachments: [
      { filename: `${input.displayNumber.replace(/[^\w.-]/g, '-')}.pdf`, content: input.pdf },
    ],
  }
}

/**
 * To the group owner when a shift that doesn't auto-post is past and still unconfirmed
 * (scheduling.md#step-3-reminders).
 */
export function shiftToConfirmEmail(input: {
  groupName: string
  date: LocalDate
  url: string
}): EmailContent {
  const day = dayLabel(input.date)
  return message(
    `Confirm your shift on ${day}`,
    [
      `Your shift in ${input.groupName} on ${day} hasn't been confirmed yet.`,
      'Confirm it, or change the hours if they were different, so it goes on your invoice.',
    ],
    { label: 'Confirm the shift', url: input.url },
  )
}

/**
 * To the person who started a timer that has run for more than 12 hours
 * (scheduling.md#step-3-reminders). `startedAt` is the row's UTC instant; it is shown in the
 * group's `timeZone`.
 */
export function timerRunningEmail(input: {
  groupName: string
  startedAt: string
  timeZone: string
  url: string
}): EmailContent {
  const started = new Date(input.startedAt)
  // Without a time or an offset, Date guesses (UTC midnight, or the machine's timezone) and
  // the email shows a made-up time.
  if (!INSTANT.test(input.startedAt) || Number.isNaN(started.getTime())) {
    throw new RangeError('startedAt must be an ISO date and time, e.g. 2026-10-15T21:02:00.000Z')
  }
  const since = `${dayLabel(localToday(input.timeZone, started))}, ${clockTime(started, input.timeZone)}`
  return message(
    'Your timer is still running',
    [
      `Your timer in ${input.groupName} has been running since ${since}.`,
      "If you've finished, stop it and set the end time so the hours are right.",
    ],
    { label: 'Open the timer', url: input.url },
  )
}

// The same paragraphs as HTML and as plain text. Names are user-typed, so HTML escapes
// everything, and the subject is kept to one line. No images, so no tracking pixels
// (security-and-privacy.md).
function message(
  subject: string,
  paragraphs: string[],
  link?: { label: string; url: string },
): EmailContent {
  // Links are built from APP_URL; anything else (javascript:, data:) is a bug.
  if (link && !/^https?:\/\//.test(link.url)) throw new RangeError('Email links must be http(s)')
  const html = [
    '<!doctype html>',
    '<html><body style="font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.5; color: #1f2933;">',
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(link ? [`<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`] : []),
    '<p style="color: #616e7c; font-size: 13px;">Sent with Ledgerly.</p>',
    '</body></html>',
  ].join('\n')
  const text = [
    ...paragraphs,
    ...(link ? [`${link.label}: ${link.url}`] : []),
    '--\nSent with Ledgerly.',
  ].join('\n\n')
  return { subject: subject.replace(/\s+/g, ' ').trim(), html, text }
}

// To the employer: a negative balance due means they paid more than they owed.
function nothingToPay(balanceDueCents: number, currency: string): string {
  return balanceDueCents < 0
    ? `You have a credit of ${formatMoney(-balanceDueCents, currency, LOCALE)}, so there is nothing to pay.`
    : 'There is nothing to pay this time.'
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function dateParts(date: LocalDate): { year: number; month: string; day: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return { year, month: MONTHS[month - 1] as string, day }
}

/** `16 October 2026` */
function longDate(date: LocalDate): string {
  const { year, month, day } = dateParts(date)
  return `${day} ${month} ${year}`
}

/** `Thursday 16 October` */
function dayLabel(date: LocalDate): string {
  const { month, day } = dateParts(date)
  return `${WEEKDAYS[weekdayOf(date) - 1]} ${day} ${month}`
}

/**
 * `October` for a whole month, else `16 October`, `1–7 October` or `28 September – 4 October`.
 * A period across a new year names both years: `28 December 2026 – 3 January 2027`.
 */
function periodLabel(start: LocalDate, end: LocalDate): string {
  const from = dateParts(start)
  const to = dateParts(end)
  if (from.year !== to.year) return `${longDate(start)} – ${longDate(end)}`
  if (start === end) return `${from.day} ${from.month}`
  if (from.day === 1 && end === endOfMonth(start)) return from.month
  if (start.slice(0, 7) === end.slice(0, 7)) return `${from.day}–${to.day} ${to.month}`
  return `${from.day} ${from.month} – ${to.day} ${to.month}`
}

/** `periodLabel` with its year, given once: `October 2026`, `28 December 2026 – 3 January 2027`. */
function periodLabelWithYear(start: LocalDate, end: LocalDate): string {
  const year = end.slice(0, 4)
  return start.slice(0, 4) === year ? `${periodLabel(start, end)} ${year}` : periodLabel(start, end)
}

/** `8:02 am` on the wall clock in `timeZone`. */
function clockTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const part = (type: string) =>
    (parts.find((p) => p.type === type) as Intl.DateTimeFormatPart).value
  const hour = Number(part('hour'))
  return `${hour % 12 || 12}:${part('minute')} ${hour < 12 ? 'am' : 'pm'}`
}
