import { describe, expect, it } from 'vitest'
import { missingGlyphs, printable } from './pdf-glyphs'

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
