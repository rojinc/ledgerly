import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { AppwriteException } from 'appwrite'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { storage } from '../../lib/appwrite'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { useCurrentUser } from '../auth/use-current-user'
import { LedgerError } from '../transactions/use-transactions'
import { prepareReceipt } from './prepare-receipt'
import {
  fetchFileBlob,
  fetchPreview,
  MAX_RECEIPTS,
  RECEIPTS_BUCKET,
  uploadReceipt,
  useCurrentReceipts,
  useSetReceipts,
} from './use-receipts'

/** A refusal to attach or remove, in plain words. */
function attachMessage(error: unknown): string {
  if (error instanceof LedgerError && error.code === 'VALIDATION_FAILED') {
    return 'We couldn’t attach this receipt. Upload it again.'
  }
  // LOCKED and ARCHIVED come worded already (#31, #37).
  return (error as Error).message
}

function uploadMessage(error: unknown): string {
  if (error instanceof AppwriteException) {
    if (error.code === 413 || error.type === 'storage_invalid_file_size') {
      return 'This file is over 10 MB. Try a smaller photo or PDF.'
    }
    if (error.type === 'storage_file_type_unsupported') return 'Add a photo or a PDF.'
  }
  if (error instanceof TypeError) {
    return 'We couldn’t upload it. Check your connection and try again.'
  }
  return 'We couldn’t upload this file. Try again.'
}

/**
 * A transaction's receipts (#162): photos as previews, PDFs as downloads, never shown inline.
 * `mayChange`: the creator or an admin, on a row that can still change.
 */
export function ReceiptsSection({
  row,
  group,
  mayChange,
}: {
  row: Transactions
  group: Groups
  mayChange: boolean
}) {
  const verified = Boolean(useCurrentUser().data?.emailVerification)
  const list = row.receiptFileIds ?? []
  const setReceipts = useSetReceipts(row)
  const currentList = useCurrentReceipts(row)
  const heading = useRef<HTMLHeadingElement>(null)
  // Uploaded but not attached yet: Try again attaches it without uploading again.
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const [uploading, setUploading] = useState(false)
  if (list.length === 0 && !mayChange) return null
  const busy = uploading || setReceipts.isPending

  const attach = (fileId: string) => {
    setError(undefined)
    // The list as it is now: a slow upload mustn't undo someone else's change meanwhile.
    const now = currentList()
    if (now.includes(fileId)) {
      // Attached already: an earlier answer was lost, and Realtime brought the row.
      setPending(undefined)
      return
    }
    setReceipts.mutate(
      { list: [...now, fileId], optimistic: false },
      {
        onSuccess: () => setPending(undefined),
        onError: (refusal) => {
          // The ledger refused the file itself: sending it again can't help.
          if (refusal instanceof LedgerError && refusal.code === 'VALIDATION_FAILED') {
            setPending(undefined)
          }
          setError(attachMessage(refusal))
        },
      },
    )
  }

  const add = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    // The same file can be picked again after a refusal.
    event.target.value = ''
    if (!picked || busy) return
    setError(undefined)
    setPending(undefined)
    setUploading(true)
    try {
      const prepared = await prepareReceipt(picked)
      if ('error' in prepared) {
        setError(prepared.error)
        return
      }
      let fileId: string
      try {
        fileId = await uploadReceipt(prepared.file, group.$id)
      } catch (failure) {
        setError(uploadMessage(failure))
        return
      }
      setPending(fileId)
      attach(fileId)
    } finally {
      setUploading(false)
    }
  }

  const remove = (fileId: string) => {
    setError(undefined)
    // Its button goes with it: focus the heading rather than lose it.
    heading.current?.focus()
    setReceipts.mutate(
      { list: currentList().filter((id) => id !== fileId), optimistic: true },
      { onError: (refusal) => setError(attachMessage(refusal)) },
    )
  }

  return (
    <section aria-labelledby="receipts-heading" className="flex flex-col gap-3">
      <h2 id="receipts-heading" ref={heading} tabIndex={-1} className="font-medium outline-none">
        Receipts
      </h2>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No receipts yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {list.map((fileId, index) => (
            <Receipt
              key={fileId}
              fileId={fileId}
              number={index + 1}
              count={list.length}
              onRemove={mayChange ? () => remove(fileId) : undefined}
              busy={busy}
            />
          ))}
        </ul>
      )}
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        {error && <span>{error}</span>}
        {error && pending && (
          <Button
            size="sm"
            variant="outline"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) attach(pending)
            }}
          >
            Try again
          </Button>
        )}
      </div>
      {mayChange &&
        list.length < MAX_RECEIPTS &&
        (verified ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="receipt-file">Add a receipt (photo or PDF)</Label>
            <input
              id="receipt-file"
              type="file"
              accept="image/*,application/pdf"
              aria-describedby="receipt-file-status"
              // While one is on its way, another pick would be lost.
              disabled={busy}
              className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => void add(event)}
            />
            <p id="receipt-file-status" role="status" className="text-sm text-muted-foreground">
              {uploading ? 'Uploading…' : setReceipts.isPending ? 'Attaching…' : ''}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Verify your email to add receipts.</p>
        ))}
    </section>
  )
}

type Kind = { image: string } | { pdf: true } | { failed: true }

/** One receipt: a photo's preview, which opens larger, or a PDF's download. */
function Receipt({
  fileId,
  number,
  count,
  onRemove,
  busy,
}: {
  fileId: string
  number: number
  count: number
  onRemove?: () => void
  busy: boolean
}) {
  const [kind, setKind] = useState<Kind>()
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const name = `Receipt ${number} of ${count}`

  useEffect(() => {
    let gone = false
    let objectUrl: string | undefined
    void (async () => {
      try {
        const file = await storage.getFile({ bucketId: RECEIPTS_BUCKET, fileId })
        if (file.mimeType === 'application/pdf') {
          if (!gone) setKind({ pdf: true })
          return
        }
        const blob = await fetchPreview(fileId, 320)
        objectUrl = URL.createObjectURL(blob)
        if (gone) URL.revokeObjectURL(objectUrl)
        else setKind({ image: objectUrl })
      } catch {
        if (!gone) setKind({ failed: true })
      }
    })()
    return () => {
      gone = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileId])

  return (
    <li className="flex w-36 flex-col gap-2">
      {!kind ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading receipt {number}…
        </p>
      ) : 'image' in kind ? (
        <button
          ref={opener}
          type="button"
          className="overflow-hidden rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(true)}
        >
          <img src={kind.image} alt={name} className="h-36 w-36 object-cover" />
        </button>
      ) : 'pdf' in kind ? (
        <>
          <p className="text-sm">{name} (PDF)</p>
          <DownloadPdf fileId={fileId} />
        </>
      ) : (
        <p className="text-sm text-destructive">We couldn’t load receipt {number}.</p>
      )}
      {onRemove && (
        <Button
          size="sm"
          variant="outline"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onRemove()
          }}
        >
          Remove receipt {number}
        </Button>
      )}
      {open && (
        <LargeView
          fileId={fileId}
          name={name}
          onClose={() => {
            setOpen(false)
            opener.current?.focus()
          }}
        />
      )}
    </li>
  )
}

/** A PDF is downloaded, never opened in the page. */
function DownloadPdf({ fileId }: { fileId: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          setFailed(false)
          try {
            const blob = await fetchFileBlob(
              storage.getFileDownload({ bucketId: RECEIPTS_BUCKET, fileId }),
            )
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = 'receipt.pdf'
            link.click()
            // Later: Safari cancels a download whose URL goes in the same tick.
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          } catch {
            setFailed(true)
          }
        }}
      >
        Download PDF
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          We couldn’t download it. Try again.
        </p>
      )}
    </>
  )
}

/** A photo up to 1600 px, over the page; Escape or Close shuts it. */
function LargeView({
  fileId,
  name,
  onClose,
}: {
  fileId: string
  name: string
  onClose: () => void
}) {
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  const close = useRef<HTMLButtonElement>(null)
  // The latest onClose, so a re-render doesn't move focus or re-add the listener.
  const closing = useRef(onClose)
  closing.current = onClose

  useEffect(() => {
    close.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closing.current()
      // Close is its only control: Tab stays on it rather than reach the page behind.
      if (event.key === 'Tab') {
        event.preventDefault()
        close.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    let gone = false
    let objectUrl: string | undefined
    fetchPreview(fileId, 1600)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        if (gone) URL.revokeObjectURL(objectUrl)
        else setSrc(objectUrl)
      })
      .catch(() => {
        if (!gone) setFailed(true)
      })
    return () => {
      gone = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileId])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex flex-col items-center gap-3 overflow-auto bg-background/95 p-4"
    >
      <Button ref={close} variant="outline" className="self-end" onClick={onClose}>
        Close
      </Button>
      {src ? (
        <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
      ) : failed ? (
        <p className="text-destructive">We couldn’t load this receipt.</p>
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      )}
    </div>
  )
}
