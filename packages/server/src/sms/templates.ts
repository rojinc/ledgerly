// GSM 03.38: the default alphabet takes one septet a character, its extension table two (an
// escape, then the character). A text with any other character is sent as UCS-2 instead, which
// counts UTF-16 code units.
const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
)
const GSM7_EXTENSION = new Set('\f^{}\\[~]|€')
// What one segment holds, and each part of a longer text (a header takes the rest).
const SEGMENT = { gsm7: { single: 160, part: 153 }, ucs2: { single: 70, part: 67 } } as const

// The length rule (#40, the lead's call): an invite fits one GSM-7 segment, or at most two
// UCS-2 segments when a name needs UCS-2. Names are cut until it does.
const MAX_SEGMENTS = { gsm7: 1, ucs2: 2 } as const
// The group name is cut first, down to this many graphemes, before the inviter's name is.
const SHORT_GROUP_NAME = 3

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * How `text` is sent: GSM-7 when every character is in its alphabet, else UCS-2; and in how many
 * segments. A longer text is split without breaking an escape sequence or a surrogate pair.
 */
export function smsSegments(text: string): {
  encoding: keyof typeof SEGMENT
  segments: number
} {
  const chars = [...text]
  const encoding = chars.every((char) => GSM7.has(char) || GSM7_EXTENSION.has(char))
    ? 'gsm7'
    : 'ucs2'
  const sizes = chars.map((char) =>
    encoding === 'ucs2' ? char.length : GSM7_EXTENSION.has(char) ? 2 : 1,
  )
  const { single, part } = SEGMENT[encoding]
  if (sizes.reduce((sum, size) => sum + size, 0) <= single) return { encoding, segments: 1 }
  let segments = 1
  let used = 0
  for (const size of sizes) {
    if (used + size > part) {
      segments += 1
      used = 0
    }
    used += size
  }
  return { encoding, segments }
}

/**
 * The SMS to a placeholder member (identity-and-invites.md#invites): "<inviter> invited you to
 * <group> on Ledgerly: <url>". Like the email, it names the inviter, as the group calls them,
 * and the group, and nothing else. Names are cut at a grapheme until the text fits
 * MAX_SEGMENTS, with "..." in GSM-7 (which has no "…") and "…" otherwise; the link never is.
 */
export function inviteSms(input: { inviterName: string; groupName: string; url: string }): string {
  // Links are built from APP_URL; anything else (javascript:, a missing APP_URL) is a bug.
  if (!/^https?:\/\//.test(input.url)) throw new RangeError('SMS links must be http(s)')
  const message = (inviter: string, group: string) =>
    `${inviter} invited you to ${group} on Ledgerly: ${input.url}`
  const inviter = graphemes(clean(input.inviterName))
  const group = graphemes(clean(input.groupName))
  const full = message(inviter.join(''), group.join(''))
  const ellipsis = smsSegments(full).encoding === 'gsm7' ? '...' : '…'
  for (const [keepInviter, keepGroup] of cuts(inviter.length, group.length)) {
    const text = message(cut(inviter, keepInviter, ellipsis), cut(group, keepGroup, ellipsis))
    const { encoding, segments } = smsSegments(text)
    if (segments <= MAX_SEGMENTS[encoding]) return text
  }
  throw new RangeError('The invite link is too long for a text message')
}

// Names are user-typed, and one character GSM-7 lacks switches the whole text to UCS-2, which
// leaves the names a few characters. So: NFC, which turns a decomposed "é" back into GSM-7's
// own; straight quotes for curly ones, as phones type them; and runs of whitespace (a tab, a
// no-break space) as one space.
function clean(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// How many graphemes of each name to keep, in the order to try: all, then the group name down
// to SHORT_GROUP_NAME, then the inviter's name down to none, then the rest of the group name.
// None leaves just the ellipsis, so even a name of one huge grapheme can't stop the text fitting.
function* cuts(inviter: number, group: number): Generator<[number, number]> {
  const short = Math.min(group, SHORT_GROUP_NAME)
  for (let keep = group; keep >= short; keep -= 1) yield [inviter, keep]
  for (let keep = inviter - 1; keep >= 0; keep -= 1) yield [keep, short]
  for (let keep = short - 1; keep >= 0; keep -= 1) yield [0, keep]
}

// The first `keep` graphemes, without trailing spaces, then the ellipsis; or the whole name.
function cut(name: string[], keep: number, ellipsis: string): string {
  if (keep >= name.length) return name.join('')
  const kept = name.slice(0, keep)
  const end = kept.findLastIndex((grapheme) => grapheme.trim() !== '') + 1
  return `${kept.slice(0, end).join('')}${ellipsis}`
}

function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), ({ segment }) => segment)
}
