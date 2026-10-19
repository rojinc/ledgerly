// statements.md#invoice-pdf-layout-employer: the invoice PDF prints in the Roboto that pdfmake
// bundles, and pdfmake leaves out a character its font can't draw without any error (#103). So
// every text it prints goes through printable(), and a missing character shows as a visible �.

import { NOTO_EMOJI_PACKED, NOTO_SANS_CJK_PACKED } from './pdf-glyphs-noto'

/**
 * The code points that both bundled Roboto weights (regular and medium) can draw, as inclusive
 * ranges in order: Latin with accents (Vietnamese too), Greek, Cyrillic, punctuation, common
 * currency signs and U+FFFD itself. No Chinese, Japanese, Korean, Thai, Hebrew, Arabic or emoji.
 * Read from the fonts: packages/server/src/pdf/pdf-glyphs.test.ts checks it against both, and
 * its diff gives the new table if pdfmake's fonts change.
 */
export const ROBOTO_RANGES: readonly (readonly [from: number, to: number])[] = [
  [0x0000, 0x0000],
  [0x0002, 0x0002],
  [0x000d, 0x000d],
  [0x0020, 0x007e],
  [0x00a0, 0x017f],
  [0x018f, 0x018f],
  [0x0192, 0x0192],
  [0x01a0, 0x01a1],
  [0x01af, 0x01b0],
  [0x01f0, 0x01f0],
  [0x01fa, 0x01ff],
  [0x0218, 0x021b],
  [0x0237, 0x0237],
  [0x0259, 0x0259],
  [0x02bc, 0x02bc],
  [0x02c6, 0x02c7],
  [0x02c9, 0x02c9],
  [0x02d8, 0x02dd],
  [0x02f3, 0x02f3],
  [0x0300, 0x0301],
  [0x0303, 0x0303],
  [0x0309, 0x0309],
  [0x030f, 0x030f],
  [0x0323, 0x0323],
  [0x0384, 0x038a],
  [0x038c, 0x038c],
  [0x038e, 0x03a1],
  [0x03a3, 0x03ce],
  [0x03d1, 0x03d2],
  [0x03d6, 0x03d6],
  [0x0400, 0x0486],
  [0x0488, 0x0513],
  [0x1e00, 0x1e01],
  [0x1e3e, 0x1e3f],
  [0x1e80, 0x1e85],
  [0x1e9e, 0x1e9e],
  [0x1ea0, 0x1ef9],
  [0x1f4d, 0x1f4d],
  [0x2000, 0x200b],
  [0x2010, 0x2011],
  [0x2013, 0x2015],
  [0x2017, 0x201e],
  [0x2020, 0x2022],
  [0x2025, 0x2027],
  [0x2030, 0x2030],
  [0x2032, 0x2033],
  [0x2039, 0x203a],
  [0x203c, 0x203c],
  [0x2044, 0x2044],
  [0x2070, 0x2070],
  [0x2074, 0x208e],
  [0x20a3, 0x20a4],
  [0x20a6, 0x20ac],
  [0x20b1, 0x20b1],
  [0x20b9, 0x20ba],
  [0x20bc, 0x20bd],
  [0x20c1, 0x20c1],
  [0x2105, 0x2105],
  [0x2113, 0x2113],
  [0x2116, 0x2116],
  [0x2122, 0x2122],
  [0x2126, 0x2126],
  [0x212e, 0x212e],
  [0x215b, 0x215e],
  [0x2202, 0x2202],
  [0x2206, 0x2206],
  [0x220f, 0x220f],
  [0x2211, 0x2212],
  [0x221a, 0x221a],
  [0x221e, 0x221e],
  [0x222b, 0x222b],
  [0x2248, 0x2248],
  [0x2260, 0x2260],
  [0x2264, 0x2265],
  [0x25a0, 0x25a0],
  [0x25ca, 0x25cb],
  [0x25cf, 0x25cf],
  [0xee01, 0xee02],
  [0xf6c3, 0xf6c3],
  [0xfb01, 0xfb04],
  [0xfeff, 0xfeff],
  [0xfffc, 0xfffd],
  [0xffff, 0xffff],
]

// pdfmake starts a new line at a line feed instead of drawing it.
const LINE_FEED = 0x0a

function drawable(codePoint: number): boolean {
  return (
    codePoint === LINE_FEED ||
    ROBOTO_RANGES.some(([from, to]) => from <= codePoint && codePoint <= to)
  )
}

/**
 * How the PDF font can draw one character of composed (NFC) text: as itself, or else from its
 * decomposed parts when Roboto has each of them (`ṣ` → s + U+0323), or not at all (undefined).
 * Roboto has many composed letters but few combining marks (no U+0302), and some letters only
 * as base + mark, so neither form alone covers what it can draw.
 */
function drawn(char: string): string | undefined {
  if (drawable(char.codePointAt(0) as number)) return char
  const parts = char.normalize('NFD')
  return Array.from(parts).every((part) => drawable(part.codePointAt(0) as number))
    ? parts
    : undefined
}

/**
 * The code points in `text`, composed (NFC) first, that the PDF font can't draw, in order, once
 * for each time they occur. A decomposed `Ê` (E + U+0302) composes to a letter Roboto has, and a
 * `ṣ` it has no code point for draws from s + U+0323 (see drawn()). A surrogate pair, such as
 * most emoji, is one character; a lone surrogate is missing.
 */
export function missingGlyphs(text: string): number[] {
  return Array.from(text.normalize('NFC'))
    .filter((char) => drawn(char) === undefined)
    .map((char) => char.codePointAt(0) as number)
}

/**
 * `text` as the PDF font can draw it: composed (NFC), each character as drawn() gives it, and
 * each one it still can't draw replaced by U+FFFD, so the gap shows: `张三 Pty Ltd` →
 * `�� Pty Ltd`.
 */
export function printable(text: string): string {
  return Array.from(text.normalize('NFC'), (char) => drawn(char) ?? '�').join('')
}

type Ranges = readonly (readonly [from: number, to: number])[]

/** A table from pdf-glyphs-noto.ts as inclusive ranges in order, the form of ROBOTO_RANGES. */
function unpack(packed: string): Ranges {
  let to = -1
  return packed
    .trim()
    .split(/\s+/)
    .map((range) => {
      const [gap, length] = range.split(',').map((n) => Number.parseInt(n, 36)) as [number, number]
      const from = to + 1 + gap
      to = from + length
      return [from, to] as const
    })
}

// Unpacked on first use: the web app imports this module for printable() and must not pay for
// them when it starts.
let cjk: Ranges | undefined
let emoji: Ranges | undefined

/** What Noto Sans CJK SC (regular) can draw: Chinese, Japanese and Korean. */
export function cjkRanges(): Ranges {
  cjk ??= unpack(NOTO_SANS_CJK_PACKED)
  return cjk
}

/** What Noto Emoji (regular, monochrome) can draw. */
export function emojiRanges(): Ranges {
  emoji ??= unpack(NOTO_EMOJI_PACKED)
  return emoji
}

/** The invoice PDF's fonts, by their pdfmake font names. */
export type PdfFont = 'Roboto' | 'NotoSansCJK' | 'NotoEmoji'

type FontRun = { font: PdfFont; text: string }

const FONTS: readonly PdfFont[] = ['Roboto', 'NotoSansCJK', 'NotoEmoji']

// simple: a scan that stops at the first range ending at or after the code point (the ranges are
// in order). fontRuns() takes about 7 µs for a Korean letter, near the end of cjkRanges() (6,000
// in 42 ms); binary search if a profile ever shows it.
function within(ranges: Ranges, codePoint: number): boolean {
  const range = ranges.find(([, to]) => codePoint <= to)
  return range !== undefined && range[0] <= codePoint
}

function has(font: PdfFont, codePoint: number): boolean {
  if (font === 'Roboto') return drawable(codePoint)
  return within(font === 'NotoSansCJK' ? cjkRanges() : emojiRanges(), codePoint)
}

/** The first font that can draw every character of `chars`. */
function firstFont(chars: string): PdfFont | undefined {
  const codePoints = Array.from(chars, (char) => char.codePointAt(0) as number)
  return FONTS.find((font) => codePoints.every((codePoint) => has(font, codePoint)))
}

// A zero-width joiner or a variation selector changes how the character before it is drawn, so
// it has to go to the same font.
function joinsPrevious(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (0xfe00 <= codePoint && codePoint <= 0xfe0f) ||
    (0xe0100 <= codePoint && codePoint <= 0xe01ef)
  )
}

// Built on first use, like the tables, and kept: an invoice splits each text it prints.
let graphemes: Intl.Segmenter | undefined

/**
 * `text`, composed (NFC), as runs by font. Each grapheme cluster (what a reader sees as one
 * character) goes to the first font that has all of it: Roboto, then Noto Sans CJK, then Noto
 * Emoji. `张三 Pty Ltd` → NotoSansCJK `张三`, Roboto ` Pty Ltd`. Only Noto Emoji has U+FE0F,
 * U+FE0E, U+20E3 and U+200D, so an emoji sequence (`♥` + U+FE0F, a keycap, 🏃 + U+200D + `♀`)
 * goes there whole. When no font has a whole cluster, each of its characters goes to the first
 * font that has it, a zero-width joiner (U+200D) or variation selector (U+FE00–U+FE0F,
 * U+E0100–U+E01EF) staying with the character before it, and a character no font has becomes
 * U+FFFD in a Roboto run.
 */
export function fontRuns(text: string): FontRun[] {
  const runs: FontRun[] = []
  const add = (font: PdfFont, chars: string) => {
    const last = runs.at(-1)
    if (last?.font === font) last.text += chars
    else runs.push({ font, text: chars })
  }
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const { segment } of graphemes.segment(text.normalize('NFC'))) {
    const font = firstFont(segment)
    if (font) {
      add(font, segment)
      continue
    }
    for (const char of segment) {
      const last = runs.at(-1)
      const own = last && joinsPrevious(char.codePointAt(0) as number) ? last.font : firstFont(char)
      add(own ?? 'Roboto', own ? char : '\u{FFFD}')
    }
  }
  return runs
}
