import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  cjkRanges,
  emojiRanges,
  fontRuns,
  missingGlyphs,
  type PdfFont,
  printable,
  ROBOTO_RANGES,
} from './pdf-glyphs'

const codePoints = (text: string) => Array.from(text, (char) => char.codePointAt(0))

// No font of the PDF has these: Roboto, Noto Sans CJK or Noto Emoji.
describe('missingGlyphs and printable', () => {
  it.each([
    ['Hebrew', 'שלום Ltd', 'שלום', '���� Ltd'],
    ['Arabic', 'عمر', 'عمر', '���'],
    ['Thai', 'ร้าน ก', 'ร้านก', '���� �'],
    // Half a surrogate pair can't be drawn.
    ['a lone surrogate', 'a\uD83Db', '\uD83D', 'a�b'],
    // No font has a tab either.
    ['a tab', 'a\tb', '\t', 'a�b'],
    // Only what fontRuns() prints as �. Roboto has no selector or joiner, so it leaves them out.
    ['VS16 on Thai', 'ร\u{FE0F}', 'ร', '�'],
    ['a joiner after Thai', 'ก\u{200D}x', 'ก', '�x'],
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
    // In Noto Sans CJK and Noto Emoji (#270).
    ['Chinese', '张三 Pty Ltd'],
    ['Japanese', 'カフェ'],
    ['Korean', '한식당'],
    ['an emoji', 'Thanks 😀!'],
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

  it('marks an accent no font has, composed or on its own', () => {
    expect(missingGlyphs('x̂')).toEqual([0x0302])
    expect(printable('x̂')).toBe('x�')
  })

  it('counts each time a character occurs', () => {
    expect(missingGlyphs('กก and ก')).toEqual([0x0e01, 0x0e01, 0x0e01])
  })
})

describe('the Noto tables', () => {
  // The sizes #270 measured from each font file's cmap, with the first and last range.
  // packages/server/src/pdf/pdf-glyphs.test.ts checks each table against its file.
  it.each([
    ['cjkRanges', cjkRanges, 2032, 44810, [0x20, 0x7e], [0x3106c, 0x3106c]],
    ['emojiRanges', emojiRanges, 162, 1512, [0x0, 0x0], [0xfe82e, 0xfe837]],
  ])(
    '%s is in order, without overlaps, as measured',
    (_, table, rangeCount, codePointCount, first, last) => {
      const ranges = table()
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
      expect([ranges[0], ranges.at(-1)]).toEqual([first, last])
    },
  )

  // Why fontRuns() needs no emoji-first order: a cluster with one of these can only be whole in
  // Noto Emoji. A font that adds one fails here, and the order comes back with a test that needs it.
  it('has emoji style, text style, keycap and joiner in Noto Emoji only', () => {
    const fonts = { Roboto: ROBOTO_RANGES, NotoSansCJK: cjkRanges(), NotoEmoji: emojiRanges() }
    const sequenceMarks = [0x200d, 0x20e3, 0xfe0f, 0xfe0e]
    const holders = sequenceMarks.map((codePoint) =>
      Object.entries(fonts)
        .filter(([, ranges]) => ranges.some(([from, to]) => from <= codePoint && codePoint <= to))
        .map(([font]) => font),
    )
    expect(holders).toEqual(sequenceMarks.map(() => ['NotoEmoji']))
  })

  // The web app imports this module for missingGlyphs(), so starting it must not unpack them.
  it('unpacks each table on first use, once', async () => {
    vi.resetModules()
    const parse = vi.spyOn(Number, 'parseInt')
    onTestFinished(() => parse.mockRestore())
    const unpacked = () => parse.mock.calls.filter(([, radix]) => radix === 36).length
    const glyphs = await import('./pdf-glyphs')
    expect(unpacked()).toBe(0)
    const ranges = glyphs.cjkRanges()
    const calls = unpacked()
    expect(calls).toBeGreaterThan(0)
    expect(glyphs.cjkRanges()).toBe(ranges)
    expect(unpacked()).toBe(calls)
  })
})

describe('fontRuns', () => {
  const runs = (...pairs: [PdfFont, string][]) => pairs.map(([font, text]) => ({ font, text }))

  it.each([
    ['Chinese', '张三 Pty Ltd', runs(['NotoSansCJK', '张三'], ['Roboto', ' Pty Ltd'])],
    ['Japanese', '山田太郎（カタカナ）', runs(['NotoSansCJK', '山田太郎（カタカナ）'])],
    ['Korean', '김민준 Café', runs(['NotoSansCJK', '김민준'], ['Roboto', ' Café'])],
    // Roboto has no Ṣ, but draws it from S + U+0323, as printable() did (#269).
    ['a letter Roboto draws from its parts', 'Ṣàdé', runs(['Roboto', 'S\u{323}àdé'])],
    ['an emoji', 'Thanks 😀', runs(['Roboto', 'Thanks '], ['NotoEmoji', '😀'])],
    ['a flag', 'Sydney 🇦🇺', runs(['Roboto', 'Sydney '], ['NotoEmoji', '🇦🇺'])],
    ['a skin tone', 'Great 👍🏽', runs(['Roboto', 'Great '], ['NotoEmoji', '👍🏽'])],
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
    // Half a surrogate pair can't be drawn either.
    ['a lone surrogate', 'a\u{D83D}b', runs(['Roboto', 'a�b'])],
    // pdfmake starts a new line at a line feed. A Windows line end is one cluster.
    [
      'line breaks',
      'Line 1\r\nLine 2\n张',
      runs(['Roboto', 'Line 1\r\nLine 2\n'], ['NotoSansCJK', '张']),
    ],
    // Composed first: が typed as か + U+3099.
    ['decomposed kana', 'が'.normalize('NFD'), runs(['NotoSansCJK', 'が'])],
    ['nothing', '', []],
  ])('splits %s', (_, text, expected) => {
    expect(fontRuns(text)).toEqual(expected)
  })

  // What a reader sees as one character prints in one font. An emoji sequence (emoji style
  // U+FE0F, a keycap U+20E3 or a joiner U+200D) goes to Noto Emoji, as only it has all of one.
  const family = '👨\u{200D}👩\u{200D}👧'
  const runner = '🏃\u{200D}♀\u{FE0F}'
  const england = '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'
  it.each([
    ['a joined emoji', `Hi ${family}`, runs(['Roboto', 'Hi '], ['NotoEmoji', family])],
    // Noto Sans CJK has ♀ too.
    ['a joined emoji with a sign', `Go ${runner}`, runs(['Roboto', 'Go '], ['NotoEmoji', runner])],
    [
      'keycaps',
      'Press 1\u{FE0F}\u{20E3} or #\u{FE0F}\u{20E3}',
      runs(
        ['Roboto', 'Press '],
        ['NotoEmoji', '1\u{FE0F}\u{20E3}'],
        ['Roboto', ' or '],
        ['NotoEmoji', '#\u{FE0F}\u{20E3}'],
      ),
    ],
    ['a tag flag', `Go ${england}`, runs(['Roboto', 'Go '], ['NotoEmoji', england])],
    [
      'VS16 on an emoji',
      'I ❤\u{FE0F} it',
      runs(['Roboto', 'I '], ['NotoEmoji', '❤\u{FE0F}'], ['Roboto', ' it']),
    ],
    // ♥ is in Noto Sans CJK and © in Roboto: U+FE0F picks the emoji, and they stay without it.
    [
      'VS16 on a sign other fonts have',
      '♥\u{FE0F} ♥ ©\u{FE0F} ©',
      runs(
        ['NotoEmoji', '♥\u{FE0F}'],
        ['Roboto', ' '],
        ['NotoSansCJK', '♥'],
        ['Roboto', ' '],
        ['NotoEmoji', '©\u{FE0F}'],
        ['Roboto', ' ©'],
      ),
    ],
  ])('keeps %s whole', (_, text, expected) => {
    expect(fontRuns(text)).toEqual(expected)
  })

  // When no font has all of a cluster, each character goes to the first font that has it. No
  // font has Thai or lists U+E0100, and only Noto Emoji has U+200D, but a selector or a joiner
  // stays with the character before it.
  it.each([
    ['an ideographic variation', '葛\u{E0100}城', runs(['NotoSansCJK', '葛\u{E0100}城'])],
    // Roboto has neither, and would draw a box, so it leaves them out.
    ['VS16 on a character no font has', 'ร\u{FE0F}', runs(['Roboto', '�'])],
    // a + U+200D is one cluster, then b.
    ['a joiner after a letter', 'a\u{200D}b', runs(['Roboto', 'ab'])],
  ])('splits %s by character', (_, text, expected) => {
    expect(fontRuns(text)).toEqual(expected)
  })

  // The web app's draft page calls missingGlyphs() on every render (statement-page.tsx).
  // A fresh module: this one already built its segmenter in the tests above.
  it('splits by code point where the browser has no Intl.Segmenter (Firefox before 125)', async () => {
    const segmenter = Intl.Segmenter
    Object.assign(Intl, { Segmenter: undefined })
    onTestFinished(() => {
      Object.assign(Intl, { Segmenter: segmenter })
    })
    vi.resetModules()
    const glyphs = await import('./pdf-glyphs')
    const text = 'ร้าน 张三 Thanks 😀 Ṣ'
    expect(glyphs.missingGlyphs(text)).toEqual(codePoints('ร้าน'))
    expect(glyphs.printable(text)).toBe('���� 张三 Thanks 😀 S\u{323}')
    expect(glyphs.fontRuns('张三 Pty Ltd')).toEqual(
      runs(['NotoSansCJK', '张三'], ['Roboto', ' Pty Ltd']),
    )
  })
})
