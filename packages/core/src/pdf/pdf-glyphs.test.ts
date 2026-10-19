import { describe, expect, it } from 'vitest'
import {
  CJK_RANGES,
  EMOJI_RANGES,
  fontRuns,
  missingGlyphs,
  type PdfFont,
  printable,
} from './pdf-glyphs'

const codePoints = (text: string) => Array.from(text, (char) => char.codePointAt(0))

describe('missingGlyphs and printable', () => {
  it.each([
    ['Chinese', '张三 Pty Ltd', '张三', '�� Pty Ltd'],
    ['Japanese', 'カフェ', 'カフェ', '���'],
    ['Korean', '한식당', '한식당', '���'],
    ['Hebrew', 'שלום Ltd', 'שלום', '���� Ltd'],
    ['Arabic', 'عمر', 'عمر', '���'],
    ['Thai', 'ร้าน ก', 'ร้านก', '���� �'],
    // A surrogate pair: one character, one mark.
    ['an emoji', 'Thanks 😀!', '😀', 'Thanks �!'],
    // Half a pair can't be drawn either.
    ['a lone surrogate', 'a\uD83Db', '\uD83D', 'a�b'],
    // Roboto has no tab either.
    ['a tab', 'a\tb', '\t', 'a�b'],
  ])('marks %s', (_, text, missing, printed) => {
    expect(missingGlyphs(text)).toEqual(codePoints(missing))
    expect(printable(text)).toBe(printed)
  })

  it.each([
    ['Latin with accents', 'Café Ngọc, Nguyễn Thị Ánh, Søren Æbelø, Łódź'],
    ['Cyrillic', 'Жанна Іванівна'],
    ['Greek', 'Αθηνά'],
    ['money and punctuation', '€12 · ₹5 · £3 – “quoted” … ¥7'],
    ['the mark itself', '�'],
    // pdfmake starts a new line there instead of drawing it.
    ['line breaks', 'Line 1\nLine 2\r\nLine 3'],
    // breakable() (server pdf/layout.ts) puts these into long words.
    ['a zero-width space', 'ABC​DEF'],
    ['nothing', ''],
  ])('keeps %s', (_, text) => {
    expect(missingGlyphs(text)).toEqual([])
    expect(printable(text)).toBe(text)
  })

  // Decomposed, as macOS paste and some Vietnamese input methods give it: Roboto lacks most
  // combining marks (no U+0302), but has the composed letters.
  it.each([
    ['Vietnamese', 'Nguyễn Thị Ánh'],
    ['a circumflex', 'Ê'],
  ])('prints decomposed %s composed', (_, text) => {
    const decomposed = text.normalize('NFD')
    expect(decomposed).not.toBe(text)
    expect(missingGlyphs(decomposed)).toEqual([])
    expect(printable(decomposed)).toBe(text.normalize('NFC'))
  })

  // Composed letters Roboto has no code point for, but whose base and mark it has: it draws
  // them from the parts (Yoruba, transliterations, Greek varia), typed either way.
  it.each([
    ['s with a dot below', 'ṣ', 'ṣ'],
    ['D with a dot below', 'Ḍ', 'Ḍ'],
    ['Greek alpha with varia', 'ὰ', 'ὰ'],
    // Only Ṣ needs its parts: à and é are in Roboto as they are.
    ['a Yoruba name', 'Ṣàdé', 'Ṣàdé'],
  ])('prints %s from its parts', (_, text, printed) => {
    for (const input of [text, text.normalize('NFD')]) {
      expect(missingGlyphs(input)).toEqual([])
      expect(printable(input)).toBe(printed)
    }
  })

  it('marks an accent Roboto has neither composed nor on its own', () => {
    expect(missingGlyphs('x̂')).toEqual([0x0302])
    expect(printable('x̂')).toBe('x�')
  })

  it('counts each time a character occurs', () => {
    expect(missingGlyphs('张张 and 张')).toEqual([0x5f20, 0x5f20, 0x5f20])
  })
})

describe('the Noto tables', () => {
  // The sizes #270 measured from each font file's cmap. A server test checks the tables against
  // the files once they are in the repo.
  it.each([
    ['CJK_RANGES', CJK_RANGES, 2032, 44810],
    ['EMOJI_RANGES', EMOJI_RANGES, 162, 1512],
  ])('%s is in order, without overlaps, as measured', (_, ranges, rangeCount, codePointCount) => {
    let previousTo = -2
    const outOfOrder = ranges.filter(([from, to]) => {
      // Ranges that touch would be one range.
      const inOrder = previousTo + 1 < from && from <= to && to <= 0x10ffff
      previousTo = to
      return !inOrder
    })
    expect(outOfOrder).toEqual([])
    expect(ranges).toHaveLength(rangeCount)
    expect(ranges.reduce((sum, [from, to]) => sum + to - from + 1, 0)).toBe(codePointCount)
  })
})

describe('fontRuns', () => {
  const runs = (...pairs: [PdfFont, string][]) => pairs.map(([font, text]) => ({ font, text }))

  it.each([
    ['Chinese', '张三 Pty Ltd', runs(['NotoSansCJK', '张三'], ['Roboto', ' Pty Ltd'])],
    ['Japanese', '山田太郎（カタカナ）', runs(['NotoSansCJK', '山田太郎（カタカナ）'])],
    ['Korean', '김민준 Café', runs(['NotoSansCJK', '김민준'], ['Roboto', ' Café'])],
    ['an emoji', 'Thanks 😀', runs(['Roboto', 'Thanks '], ['NotoEmoji', '😀'])],
    // Neighbours in the same font are one run, � included.
    [
      'runs of each font',
      '😀👍 ok, 张 🎉ร้าน',
      runs(
        ['NotoEmoji', '😀👍'],
        ['Roboto', ' ok, '],
        ['NotoSansCJK', '张'],
        ['Roboto', ' '],
        ['NotoEmoji', '🎉'],
        ['Roboto', '����'],
      ),
    ],
    // No font has Thai: each character becomes � in Roboto, as printable() gives it.
    ['Thai', 'ร้าน Ltd', runs(['Roboto', '���� Ltd'])],
    // Composed first: が typed as か + U+3099.
    ['decomposed kana', 'が'.normalize('NFD'), runs(['NotoSansCJK', 'が'])],
    ['nothing', '', []],
  ])('splits %s', (_, text, expected) => {
    expect(fontRuns(text)).toEqual(expected)
  })

  // Only Noto Emoji has U+200D and U+FE0F, and no font lists U+E0100, but each changes the
  // character before it, so it goes to that character's font.
  const family = '👨\u{200D}👩\u{200D}👧'
  it.each([
    ['a joined emoji', `Hi ${family}`, runs(['Roboto', 'Hi '], ['NotoEmoji', family])],
    [
      'VS16 on an emoji',
      'I ❤\u{FE0F} it',
      runs(['Roboto', 'I '], ['NotoEmoji', '❤\u{FE0F}'], ['Roboto', ' it']),
    ],
    ['VS16 on a Roboto letter', '©\u{FE0F} Ltd', runs(['Roboto', '©\u{FE0F} Ltd'])],
    ['an ideographic variation', '葛\u{E0100}城', runs(['NotoSansCJK', '葛\u{E0100}城'])],
    ['VS16 on a character no font has', 'ร\u{FE0F}', runs(['Roboto', '�\u{FE0F}'])],
  ])('keeps %s with the character before it', (_, text, expected) => {
    expect(fontRuns(text)).toEqual(expected)
  })
})
