import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { checkFonts, FONT_FILES } from './fonts'

describe('checkFonts', () => {
  it('passes when each font file is in the folder, and names one that is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fonts-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    for (const file of Object.values(FONT_FILES)) writeFileSync(join(dir, file), '')
    const folder = pathToFileURL(`${dir}/`)
    expect(() => checkFonts(folder)).not.toThrow()
    rmSync(join(dir, FONT_FILES.NotoEmoji))
    expect(() => checkFonts(folder)).toThrow(
      expect.objectContaining({
        name: 'FontFileMissing',
        message: expect.stringContaining(FONT_FILES.NotoEmoji),
      }),
    )
  })

  // In the bundle that is dist/fonts/, where the build copies them; the source has none.
  it('looks in fonts/ beside the module by default', () => {
    expect(() => checkFonts()).toThrow(`src/pdf/fonts/${FONT_FILES.NotoSansCJK}`)
  })
})
