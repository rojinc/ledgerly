// statements.md#invoice-pdf-layout-employer: the invoice PDF prints in the Roboto that pdfmake
// bundles, and pdfmake leaves out a character its font can't draw without any error (#103). So
// every text it prints goes through printable(), and a missing character shows as a visible �.

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
 * The code points in `text` that the PDF font can't draw, in order, once for each time they
 * occur. A surrogate pair, such as most emoji, is one character; a lone surrogate is missing.
 */
export function missingGlyphs(text: string): number[] {
  return Array.from(text, (char) => char.codePointAt(0) as number).filter(
    (codePoint) => !drawable(codePoint),
  )
}

/**
 * `text` with each character the PDF font can't draw replaced by U+FFFD, so the gap shows:
 * `张三 Pty Ltd` → `�� Pty Ltd`.
 */
export function printable(text: string): string {
  return Array.from(text, (char) =>
    drawable(char.codePointAt(0) as number) ? char : '\uFFFD',
  ).join('')
}
