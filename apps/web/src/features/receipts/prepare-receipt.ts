// Getting a receipt ready to upload, in the browser (#162): photos are scaled down and
// re-encoded, which also drops their metadata such as location; PDFs go up as they are.

/** The longest side a receipt photo keeps (scaling.md: receipt storage). */
export const MAX_SIDE = 1600
/** The receipts bucket's limit (appwrite/buckets.json). */
export const MAX_BYTES = 10 * 1024 * 1024

/** A size scaled so its longest side is at most `max`, never up. */
export function fitWithin(width: number, height: number, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** WebP where the browser can encode it, otherwise JPEG. */
export function photoType(canEncodeWebp: boolean) {
  return canEncodeWebp
    ? { type: 'image/webp', name: 'receipt.webp' }
    : { type: 'image/jpeg', name: 'receipt.jpg' }
}

/** Whether this browser's canvas makes WebP, rather than falling back to PNG. */
function canEncodeWebp(): boolean {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  return canvas.toDataURL('image/webp').startsWith('data:image/webp')
}

export type Prepared = { file: File } | { error: string }

const TOO_BIG = 'This file is over 10 MB. Try a smaller photo or PDF.'

/**
 * The file to upload, named `receipt.webp`, `receipt.jpg` or `receipt.pdf` (never the device's
 * name), or why it can't be.
 */
export async function prepareReceipt(picked: File): Promise<Prepared> {
  if (picked.type === 'application/pdf') {
    if (picked.size > MAX_BYTES) return { error: TOO_BIG }
    return { file: new File([picked], 'receipt.pdf', { type: 'application/pdf' }) }
  }
  if (!picked.type.startsWith('image/')) return { error: 'Add a photo or a PDF.' }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(picked)
  } catch {
    return { error: 'We couldn’t read this photo. Try a JPEG or PNG.' }
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    return { error: 'We couldn’t read this photo. Try a JPEG or PNG.' }
  }
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const { type, name } = photoType(canEncodeWebp())
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85))
  if (!blob) return { error: 'We couldn’t read this photo. Try a JPEG or PNG.' }
  if (blob.size > MAX_BYTES) return { error: TOO_BIG }
  return { file: new File([blob], name, { type }) }
}
