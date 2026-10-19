import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fitWithin, MAX_BYTES, photoType, prepareReceipt } from './prepare-receipt'

describe('fitWithin', () => {
  it.each([
    [4032, 3024, 1600, 1200],
    [1200, 4000, 480, 1600],
    [800, 600, 800, 600],
    [1600, 1600, 1600, 1600],
    [3000, 1, 1600, 1],
  ])('fits %d×%d into %d×%d, never scaling up', (width, height, fitWidth, fitHeight) => {
    expect(fitWithin(width, height)).toEqual({ width: fitWidth, height: fitHeight })
  })
})

describe('photoType', () => {
  it('uses WebP where the browser makes it, otherwise JPEG', () => {
    expect(photoType(true)).toEqual({ type: 'image/webp', name: 'receipt.webp' })
    expect(photoType(false)).toEqual({ type: 'image/jpeg', name: 'receipt.jpg' })
  })
})

describe('prepareReceipt', () => {
  // jsdom has no image decoding or canvas encoding: stand-ins that record what was asked.
  let drawn: number[] = []
  let encoded: { type?: string; quality?: unknown } = {}
  let webp = true
  let blobSize = 1000
  beforeEach(() => {
    drawn = []
    encoded = {}
    webp = true
    blobSize = 1000
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (file: File) => {
        if (file.type === 'image/heic') throw new Error('unsupported')
        return { width: 4032, height: 3024, close: vi.fn() }
      }),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return {
        drawImage: (_image: unknown, ...box: number[]) => drawn.push(...box),
      } as never
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type?: string) =>
      webp && type === 'image/webp' ? 'data:image/webp;base64,' : 'data:image/png;base64,',
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type, quality) => {
      encoded = { type, quality }
      done(new Blob([new Uint8Array(blobSize)], { type }))
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const photo = (type = 'image/jpeg') => new File([new Uint8Array(10)], 'IMG_0042.JPG', { type })

  it('scales a photo to 1600 px and saves it as receipt.webp, not the device’s name', async () => {
    const prepared = await prepareReceipt(photo())
    expect(drawn).toEqual([0, 0, 1600, 1200])
    expect(encoded).toEqual({ type: 'image/webp', quality: 0.85 })
    expect('file' in prepared && [prepared.file.name, prepared.file.type]).toEqual([
      'receipt.webp',
      'image/webp',
    ])
  })

  it('saves JPEG where the browser can’t make WebP', async () => {
    webp = false
    const prepared = await prepareReceipt(photo('image/png'))
    expect(encoded.type).toBe('image/jpeg')
    expect('file' in prepared && prepared.file.name).toBe('receipt.jpg')
  })

  it('uploads a PDF unchanged, as receipt.pdf', async () => {
    const pdf = new File(['%PDF-1.7'], 'Bank statement.pdf', { type: 'application/pdf' })
    const prepared = await prepareReceipt(pdf)
    expect('file' in prepared && prepared.file.name).toBe('receipt.pdf')
    expect('file' in prepared && (await prepared.file.text())).toBe('%PDF-1.7')
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('refuses other files, unreadable photos and anything over 10 MB', async () => {
    expect(await prepareReceipt(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toEqual({
      error: 'Add a photo or a PDF.',
    })
    expect(await prepareReceipt(photo('image/heic'))).toEqual({
      error: 'We couldn’t read this photo. Try a JPEG or PNG.',
    })
    blobSize = MAX_BYTES + 1
    expect(await prepareReceipt(photo())).toEqual({
      error: 'This file is over 10 MB. Try a smaller photo or PDF.',
    })
    const bigPdf = new File([new Uint8Array(MAX_BYTES + 1)], 'a.pdf', { type: 'application/pdf' })
    expect(await prepareReceipt(bigPdf)).toEqual({
      error: 'This file is over 10 MB. Try a smaller photo or PDF.',
    })
  })
})
