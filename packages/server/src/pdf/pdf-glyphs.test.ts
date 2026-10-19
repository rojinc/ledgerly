import { createRequire } from 'node:module'
import { ROBOTO_RANGES } from '@ledgerly/core/pdf/pdf-glyphs'
import vfs from 'pdfmake/build/vfs_fonts.js'
import { describe, expect, it } from 'vitest'

// fontkit (pdfkit's font parser, a devDependency for this test only) ships no types: this is all
// the test uses of it.
const { create } = createRequire(import.meta.url)('fontkit') as {
  create(font: Buffer): { characterSet: number[] }
}

/** The code points a font bundled with pdfmake can draw. */
function characterSet(file: string): Set<number> {
  return new Set(create(Buffer.from(vfs[file] as string, 'base64')).characterSet)
}

/** Code points as inclusive ranges, in order, the form of the core table. */
function ranges(codePoints: number[]): [number, number][] {
  const result: [number, number][] = []
  for (const codePoint of codePoints.toSorted((a, b) => a - b)) {
    const last = result.at(-1)
    if (last && last[1] === codePoint - 1) last[1] = codePoint
    else result.push([codePoint, codePoint])
  }
  return result
}

describe('ROBOTO_RANGES', () => {
  // The invoice PDF prints in these two (layout.ts). If pdfmake's fonts change, this fails, and
  // its diff is the new table for packages/core/src/pdf/pdf-glyphs.ts.
  it('is exactly what both bundled Roboto weights can draw', () => {
    const regular = characterSet('Roboto-Regular.ttf')
    const medium = characterSet('Roboto-Medium.ttf')
    expect(ROBOTO_RANGES).toEqual(ranges([...regular].filter((codePoint) => medium.has(codePoint))))
  })
})
