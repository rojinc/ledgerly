import { endOfMonth, type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { formatMoney, formatNet } from '@ledgerly/core/money/format'
import type { PersonalReport } from '@ledgerly/core/reports/personal-report'
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
    [{ label: `Review the ${input.type}`, url: input.url }],
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

/** One suggested transfer as one housemate sees it: who to pay, or who pays them. */
export type DivideTransfer = { name: string; cents: number }

/**
 * To one housemate when a divide is sent: where they stand and their own suggested transfers,
 * with the divide PDF attached (statements.md#3-send-and-resend). It names no one's address, and
 * has no reply-to.
 */
export function divideEmail(input: {
  groupName: string
  periodStart: LocalDate
  periodEnd: LocalDate
  currency: string
  closingCents: number
  /** Whom they pay. */
  pays: DivideTransfer[]
  /** Who pays them. */
  receives: DivideTransfer[]
  url: string
  pdf: Uint8Array
}): EmailContent {
  const money = (cents: number) => formatMoney(cents, input.currency, LOCALE)
  const period = periodLabel(input.periodStart, input.periodEnd)
  const standing =
    input.closingCents < 0
      ? `You owe ${money(-input.closingCents)}.`
      : input.closingCents > 0
        ? `You're owed ${money(input.closingCents)}.`
        : "You're settled up."
  return {
    ...message(
      `Your ${period} divide for ${input.groupName}`,
      [
        `Here's the ${period} divide for ${input.groupName}. The PDF is attached.`,
        standing,
        ...input.pays.map((to) => `Pay ${to.name} ${money(to.cents)}.`),
        ...input.receives.map((from) => `${from.name} pays you ${money(from.cents)}.`),
      ],
      [{ label: 'Open the divide', url: input.url }],
    ),
    attachments: [{ filename: `divide-${input.periodEnd}.pdf`, content: input.pdf }],
  }
}

/**
 * To the group owner when a past shift is still unconfirmed: one that doesn't auto-post, or one
 * step 2 couldn't post (scheduling.md#step-3-reminders).
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
    [{ label: 'Confirm the shift', url: input.url }],
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
    [{ label: 'Open the timer', url: input.url }],
  )
}

/**
 * To a placeholder member, from someone in their group (identity-and-invites.md#invites). It
 * names the inviter, as the group calls them, and the group, and nothing else: no amounts. The
 * group is named as a label, since a pair group's name is what its creator calls the person
 * being invited. Both names are free text, so they stay out of the subject and are cut as a
 * reminder's sender is (`shortLine`). `url` carries the token in its fragment, which browsers
 * never send to a server.
 */
export function inviteEmail(input: {
  inviterName: string
  groupName: string
  url: string
}): EmailContent {
  return message(
    "You've been invited to a group on Ledgerly",
    [
      `${shortLine(input.inviterName)} added you to the group “${shortLine(input.groupName)}” on Ledgerly and invited you to join.`,
      "If you weren't expecting this, you can ignore this email.",
    ],
    [{ label: 'Accept the invite', url: input.url }],
  )
}

/**
 * To the account's verified email when its password is set or changed
 * (identity-and-invites.md#password-notice). `changedAt` is the user's `passwordUpdate`, shown on
 * the wall clock in `timeZone`. No password, token or link that signs anyone in: `url` is the
 * app's sign-in page.
 */
export function passwordChangedEmail(input: {
  changedAt: string
  timeZone: string
  url: string
}): EmailContent {
  const changed = new Date(input.changedAt)
  if (!INSTANT.test(input.changedAt) || Number.isNaN(changed.getTime())) {
    throw new RangeError('changedAt must be an ISO date and time, e.g. 2026-10-15T21:02:00.000Z')
  }
  const when = `${dayLabel(localToday(input.timeZone, changed))}, ${clockTime(changed, input.timeZone)}`
  return message(
    'Your Ledgerly password was changed',
    [
      `The password for your Ledgerly account was set or changed on ${when} (${input.timeZone} time).`,
      "If this was you, there's nothing to do.",
      "If this wasn't you, reset your password now.",
    ],
    [{ label: 'Go to Ledgerly', url: input.url }],
  )
}

/**
 * To an old verified address when the account's email changes
 * (identity-and-invites.md#email-and-phone-change-notice). `newEmail` is the account's email as
 * Appwrite holds it, shown masked (`j***@example.com`). `supportEmail` is the `SUPPORT_EMAIL`
 * variable, empty when it isn't set. No token or link that signs anyone in: `url` is the app's
 * sign-in page.
 */
export function emailChangedEmail(input: {
  newEmail: string
  supportEmail: string
  url: string
}): EmailContent {
  return message(
    'Your Ledgerly email address was changed',
    [
      `The email address for your Ledgerly account was changed to ${maskedEmail(input.newEmail)}.`,
      "If this was you, there's nothing to do.",
      notYou(input.supportEmail),
    ],
    [{ label: 'Go to Ledgerly', url: input.url }],
  )
}

/**
 * To the account's verified email when its phone number changes
 * (identity-and-invites.md#email-and-phone-change-notice): the new number by its last 3 digits
 * only, or that it was removed when `newPhone` is empty. As `emailChangedEmail` otherwise.
 */
export function phoneChangedEmail(input: {
  newPhone: string
  supportEmail: string
  url: string
}): EmailContent {
  const digits = input.newPhone.replace(/\D/g, '')
  return message(
    'Your Ledgerly phone number was changed',
    [
      digits === ''
        ? 'The phone number was removed from your Ledgerly account.'
        : `The phone number on your Ledgerly account was changed to one ending in ${digits.slice(-3)}.`,
      "If this was you, there's nothing to do.",
      notYou(input.supportEmail),
    ],
    [{ label: 'Go to Ledgerly', url: input.url }],
  )
}

// The first character of the address, then `***`, then `@` and the domain.
function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@')
  const first = Array.from(email.slice(0, Math.max(at, 0)))[0] ?? ''
  return `${first}***${at < 0 ? '' : email.slice(at)}`
}

// Plain text, never a link: the reader writes from the address that got the notice.
function notYou(supportEmail: string): string {
  const to = supportEmail.trim()
  return to
    ? `If this wasn't you, write to ${to} from this address right away.`
    : "If this wasn't you, reply to this email right away."
}

/**
 * A reminder that someone owes the sender money (F-63, identity-and-invites.md#reminders), to
 * the address the sender typed. `senderName` is the sender's name in that group, free text they
 * chose, so it stays out of the subject and is cut (`shortLine`); `amountCents` is the whole
 * balance owed. Nothing else: no recipient or group name (both are what the sender calls them),
 * no transactions, no note, and only a link to the app.
 */
export function reminderEmail(input: {
  senderName: string
  amountCents: number
  currency: string
  url: string
}): EmailContent {
  // A balance is worked out from amounts, so it can pass the amount cap.
  const amount = formatNet(input.amountCents, input.currency, LOCALE)
  return message(
    'You have a payment reminder',
    [
      `${shortLine(input.senderName)} sent you a reminder that you owe them ${amount}.`,
      "If you've already paid, let them know so they can record it.",
    ],
    [{ label: 'Open Ledgerly', url: input.url }],
  )
}

// The most of someone's own text a reminder or an invite shows, per name.
const SHORT_LINE_LENGTH = 40
const GRAPHEMES = new Intl.Segmenter(LOCALE, { granularity: 'grapheme' })
// Unicode's Bidi_Control characters: embeddings and overrides, isolates, and the three marks
// (LRM, RLM and the Arabic letter mark). They can make text around the name read in another
// order. The zero-width joiner (U+200D) isn't one, so it stays: emoji need it.
const BIDI_CONTROLS = /\p{Bidi_Control}/gu

/**
 * Free text someone chose, for an email body: one line, as the subject is, so a line break
 * can't start a paragraph of its own, with no bidi controls, and at most 40 characters as people
 * see them, so an emoji sequence isn't split; a longer one ends in "…". Cut before `message()`
 * escapes it, so an escape is never cut in half.
 */
function shortLine(text: string): string {
  const characters = Array.from(
    GRAPHEMES.segment(text.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim()),
    (part) => part.segment,
  )
  return characters.length > SHORT_LINE_LENGTH
    ? `${characters
        .slice(0, SHORT_LINE_LENGTH - 1)
        .join('')
        .trimEnd()}…`
    : characters.join('')
}

/** What one group owes the person (positive) or they owe it (negative), in its currency. */
export type SummaryBalance = { groupName: string; currency: string; cents: number }

/**
 * A person's summary for a period (scheduling.md#step-4-summary-emails). For each currency:
 * what they spent, by category, and their income, from their `reports`; then the groups that
 * owe them and the groups they owe, from `balances` (leave out the ones at 0). `profileUrl` is
 * where they turn summaries off.
 */
export function summaryEmail(input: {
  periodStart: LocalDate
  periodEnd: LocalDate
  reports: readonly PersonalReport[]
  balances: readonly SummaryBalance[]
  url: string
  profileUrl: string
}): EmailContent {
  const period = periodLabel(input.periodStart, input.periodEnd)
  const currencies = [
    ...new Set([...input.reports, ...input.balances].map((entry) => entry.currency)),
  ].sort()
  return message(
    `Your ${period} summary`,
    [
      `Here is your summary for ${period}.`,
      ...currencies.flatMap((currency) => summaryBlocks(currency, input, currencies.length > 1)),
      'You can turn these emails off, or change how often they come, in your profile.',
    ],
    [
      { label: 'Open Ledgerly', url: input.url },
      { label: 'Change your summary emails', url: input.profileUrl },
    ],
  )
}

function summaryBlocks(
  currency: string,
  {
    reports,
    balances,
  }: { reports: readonly PersonalReport[]; balances: readonly SummaryBalance[] },
  named: boolean,
): Block[] {
  const money = (cents: number) => formatMoney(cents, currency, LOCALE)
  const report = reports.find((entry) => entry.currency === currency)
  // Biggest first, then by name.
  const categories = Object.entries(report?.spendingByCategory ?? {})
    .filter(([, cents]) => cents !== 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
  // Biggest first, as for categories.
  const sorted = balances
    .filter((entry) => entry.currency === currency)
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || (a.groupName < b.groupName ? -1 : 1))
  const owed = sorted.filter((entry) => entry.cents > 0)
  const owing = sorted.filter((entry) => entry.cents < 0)
  return [
    ...(named ? [`In ${currency}:`] : []),
    ...(report
      ? [
          `You spent ${money(report.spendingCents)}.`,
          ...(categories.length > 0
            ? [categories.map(([category, cents]) => `${categoryName(category)}: ${money(cents)}`)]
            : []),
          `Your income was ${money(report.incomeCents)}.`,
        ]
      : []),
    ...(owed.length > 0
      ? ['Owed to you:', owed.map((entry) => `${entry.groupName}: ${money(entry.cents)}`)]
      : []),
    ...(owing.length > 0
      ? ['You owe:', owing.map((entry) => `${entry.groupName}: ${money(-entry.cents)}`)]
      : []),
  ]
}

// `groceries` → `Groceries`; spending with no category is reported as `none` (ledger.md#reports).
function categoryName(category: string): string {
  return category === 'none' ? 'No category' : category.charAt(0).toUpperCase() + category.slice(1)
}

// A paragraph, or a list of short lines.
type Block = string | readonly string[]
type Link = { label: string; url: string }

// The same paragraphs and lists as HTML and as plain text. Names are user-typed, so HTML
// escapes everything, and the subject is kept to one line. No images, so no tracking pixels
// (security-and-privacy.md).
function message(
  subject: string,
  blocks: readonly Block[],
  links: readonly Link[] = [],
): EmailContent {
  // Links are built from APP_URL; anything else (javascript:, data:) is a bug.
  if (links.some((link) => !/^https?:\/\//.test(link.url))) {
    throw new RangeError('Email links must be http(s)')
  }
  const html = [
    '<!doctype html>',
    '<html><body style="font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.5; color: #1f2933;">',
    ...blocks.map((block) =>
      typeof block === 'string'
        ? `<p>${escapeHtml(block)}</p>`
        : `<ul>${block.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    ),
    ...links.map(
      (link) => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`,
    ),
    '<p style="color: #616e7c; font-size: 13px;">Sent with Ledgerly.</p>',
    '</body></html>',
  ].join('\n')
  const text = [
    ...blocks.map((block) =>
      typeof block === 'string' ? block : block.map((line) => `- ${line}`).join('\n'),
    ),
    ...links.map((link) => `${link.label}: ${link.url}`),
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
 * A period across a new year names both years: `28 December 2026 – 3 January 2027`. Also names
 * a statement in its activity rows.
 */
export function periodLabel(start: LocalDate, end: LocalDate): string {
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
