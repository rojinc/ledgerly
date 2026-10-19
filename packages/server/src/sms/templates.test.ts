import { describe, expect, it } from 'vitest'
import { inviteSms, smsSegments } from './templates'

// A long production address (40 characters) and a real-length token (32 bytes, base64url), so
// the names get only what is left: 39 septets in GSM-7, 13 UTF-16 units in UCS-2.
const APP_URL = 'https://ledgerly-production1.example.app'
const TOKEN = Buffer.alloc(32, 0xfb).toString('base64url')
const URL = `${APP_URL}/invite#${TOKEN}`
const LONG_NAME =
  'Bartholomew-Maximilian Featherstonehaugh-Worthington of Kensington and Chelsea upon the Thames'
const LONG_GROUP =
  'The Flat on the Corner of Campbell Parade and Hall Street, Bondi Beach, New South Wales 2026'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (text: string) => Array.from(GRAPHEMES.segment(text), ({ segment }) => segment)

function invite(inviterName: string, groupName: string): string {
  return inviteSms({ inviterName, groupName, url: URL })
}

/** The two names as they appear in an invite. */
function namesIn(text: string): [string, string] {
  const match = text.match(/^(.*) invited you to (.*) on Ledgerly: (.*)$/su)
  expect(match?.[3]).toBe(URL)
  return [match?.[1] ?? '', match?.[2] ?? '']
}

/** `shown` is all of `name`, or its first whole graphemes followed by the ellipsis. */
function expectWholeGraphemes(shown: string, name: string, ellipsis: string) {
  if (shown === name) return
  expect(shown.endsWith(ellipsis)).toBe(true)
  const kept = graphemes(shown.slice(0, -ellipsis.length))
  expect(kept).toEqual(graphemes(name).slice(0, kept.length))
}

describe('smsSegments', () => {
  it('fits 160 septets of the GSM-7 alphabet in one segment, and 153 a part after that', () => {
    const alphabet =
      '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
      '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
    expect(smsSegments(alphabet)).toEqual({ encoding: 'gsm7', segments: 1 })
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'gsm7', segments: 1 })
    expect(smsSegments('a'.repeat(161))).toEqual({ encoding: 'gsm7', segments: 2 })
    expect(smsSegments('a'.repeat(306))).toEqual({ encoding: 'gsm7', segments: 2 })
    expect(smsSegments('a'.repeat(307))).toEqual({ encoding: 'gsm7', segments: 3 })
    expect(smsSegments('')).toEqual({ encoding: 'gsm7', segments: 1 })
  })

  it.each([...'^{}\\[~]|€\f'])('counts the extension character %j as two septets', (char) => {
    expect(smsSegments(`${'a'.repeat(158)}${char}`)).toEqual({ encoding: 'gsm7', segments: 1 })
    expect(smsSegments(`${'a'.repeat(159)}${char}`)).toEqual({ encoding: 'gsm7', segments: 2 })
  })

  it('never splits an escape sequence between parts', () => {
    // 306 septets would be two parts of 153, but the € can't straddle them.
    expect(smsSegments(`${'a'.repeat(152)}€${'a'.repeat(152)}`)).toEqual({
      encoding: 'gsm7',
      segments: 3,
    })
  })

  it.each([
    ['…', 'an ellipsis'],
    ['ë', 'a letter GSM-7 lacks'],
    ['’', 'a curly apostrophe'],
    ['\t', 'a tab'],
    [' ', 'a no-break space'],
    ['王', 'Chinese'],
    ['😀', 'an emoji'],
  ])('sends %j (%s) as UCS-2', (char) => {
    expect(smsSegments(`Annie ${char}`).encoding).toBe('ucs2')
  })

  it('fits 70 UTF-16 units of UCS-2 in one segment, and 67 a part after that', () => {
    expect(smsSegments('王'.repeat(70))).toEqual({ encoding: 'ucs2', segments: 1 })
    expect(smsSegments('王'.repeat(71))).toEqual({ encoding: 'ucs2', segments: 2 })
    expect(smsSegments('王'.repeat(134))).toEqual({ encoding: 'ucs2', segments: 2 })
    expect(smsSegments('王'.repeat(135))).toEqual({ encoding: 'ucs2', segments: 3 })
    expect(smsSegments('😀'.repeat(35))).toEqual({ encoding: 'ucs2', segments: 1 })
  })

  it('never splits a surrogate pair between parts', () => {
    // 134 units would be two parts of 67, but the emoji can't straddle them.
    expect(smsSegments(`${'王'.repeat(66)}😀${'王'.repeat(66)}`)).toEqual({
      encoding: 'ucs2',
      segments: 3,
    })
  })
})

describe('inviteSms', () => {
  it('names the inviter and the group, and leaves short names as they are', () => {
    expect(URL).toHaveLength(91)
    expect(invite('Annie', 'Flat 2')).toBe(`Annie invited you to Flat 2 on Ledgerly: ${URL}`)
    expect(invite('王小明', '合租公寓')).toBe(`王小明 invited you to 合租公寓 on Ledgerly: ${URL}`)
  })

  it('fits the longest Latin names in one GSM-7 segment: the group first, down to 3', () => {
    const text = invite(LONG_NAME, LONG_GROUP)
    expect(text).toBe(`Bartholomew-Maximilian Feather... invited you to The... on Ledgerly: ${URL}`)
    expect(text).toHaveLength(160)
    expect(smsSegments(text)).toEqual({ encoding: 'gsm7', segments: 1 })
  })

  it('cuts only the group name while that is enough', () => {
    const text = invite('Annie', LONG_GROUP)
    expect(text).toBe(`Annie invited you to The Flat on the Corner of Campb... on Ledgerly: ${URL}`)
    expect(smsSegments(text)).toEqual({ encoding: 'gsm7', segments: 1 })
  })

  it('counts extension characters as two septets', () => {
    // 5 + 34 septets of names fill the segment exactly; a | makes it one too many.
    expect(invite('Annie', 'a'.repeat(34))).toHaveLength(160)
    const text = invite('Annie', `${'a'.repeat(33)}|`)
    expect(namesIn(text)).toEqual(['Annie', `${'a'.repeat(31)}...`])
    expect(smsSegments(text)).toEqual({ encoding: 'gsm7', segments: 1 })
    expect(namesIn(invite('Annie', '[Flat] {2} €5'))).toEqual(['Annie', '[Flat] {2} €5'])
  })

  it('drops spaces before the ellipsis', () => {
    // 31 characters fit before the "...", and the 31st is a space.
    const group = `${'a'.repeat(30)} ${'b'.repeat(10)}`
    expect(namesIn(invite('Annie', group))).toEqual(['Annie', `${'a'.repeat(30)}...`])
  })

  it('turns runs of whitespace into one space, so a tab keeps the text GSM-7', () => {
    const text = invite('Ann\tLee', 'Flat  2')
    expect(text).toBe(`Ann Lee invited you to Flat 2 on Ledgerly: ${URL}`)
    expect(smsSegments(text).encoding).toBe('gsm7')
  })

  it.each([
    ['Devanagari', 'प्रियंका शर्मा', 'हमारा घर बोंडी में', 'प्रियं…', 'हमारा…'],
    ['Chinese', '王小明', '我们在悉尼邦迪海滩的合租公寓', '王小明', '我们在悉尼邦迪海滩…'],
    ['emoji', 'Mia 👩🏽‍💻', '🏠🏖️ Beach House 🌊', 'Mia…', '🏠🏖️…'],
    ['flags', '🇦🇺🇳🇿 Kai', 'Flat 2', '🇦🇺🇳🇿…', 'Fla…'],
    ['a family emoji', '👨‍👩‍👧‍👦 Family', 'Flat 2', '…', 'Fla…'],
    ['a letter GSM-7 lacks', 'Zoë', 'Flat 2 Bondi', 'Zoë', 'Flat 2 Bo…'],
    ['one huge grapheme', `A${'́'.repeat(40)}nn`, 'Flat 2', '…', 'Fla…'],
  ])(
    'fits %s names in two UCS-2 segments without splitting a grapheme',
    (_case, inviter, group, inviterShown, groupShown) => {
      const text = invite(inviter, group)
      expect(namesIn(text)).toEqual([inviterShown, groupShown])
      expect(text.length).toBeLessThanOrEqual(134)
      expect(smsSegments(text)).toEqual({ encoding: 'ucs2', segments: 2 })
      expectWholeGraphemes(inviterShown, inviter, '…')
      expectWholeGraphemes(groupShown, group, '…')
    },
  )

  it('never cuts the link, and refuses one too long to fit or not http(s)', () => {
    // 124 characters: it fits only with each name cut to its ellipsis.
    const url = `https://${'a'.repeat(57)}.example/invite#${TOKEN}`
    expect(url).toHaveLength(124)
    expect(inviteSms({ inviterName: 'Annie', groupName: 'Flat 2', url })).toBe(
      `... invited you to ... on Ledgerly: ${url}`,
    )
    for (const bad of [`${url}a`, `/invite#${TOKEN}`, 'javascript:alert(1)']) {
      expect(() => inviteSms({ inviterName: 'Annie', groupName: 'Flat 2', url: bad })).toThrow(
        RangeError,
      )
    }
  })
})
