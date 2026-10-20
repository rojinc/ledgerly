import type { Groups } from '@ledgerly/core/generated/rows'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { callFunction, type Err } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { Button } from '../../ui/button'
import { useCurrentUser } from '../auth/use-current-user'

/** Shown on every page of an archived group (#37). */
export const ARCHIVED_NOTICE = 'This group is archived. You can see its history but not change it.'

/**
 * A write's error in plain words: `ARCHIVED` from an old tab says what happened, not the raw
 * error (#37). Anything else keeps the function's own message, which is already plain.
 */
export function writeErrorMessage(error: Err['error']): string {
  return error.code === 'ARCHIVED'
    ? 'This group has been archived, so it can’t be changed any more. Reload the page to see it as it is now.'
    : error.message
}

/**
 * `groups POST /groups/{id}/archive` behind a confirmation: admins only, never a personal group
 * (functions-api.md#groups). Archiving is permanent in v1. `name` is the group as the page shows
 * it: a pair by its other person, not by its creator's label (#145).
 */
export function ArchiveGroup({
  group,
  name = group.name,
  onArchived,
}: {
  group: Groups
  name?: string
  onArchived: () => void
}) {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const archive = useMutation({
    mutationFn: async () => {
      // The server answers a repeat archive with the group, so ARCHIVED doesn't come back here.
      const result = await callFunction<Groups>('groups', 'POST', `/groups/${group.$id}/archive`)
      if (!result.ok) throw new Error(writeErrorMessage(result.error))
      return result.data
    },
    onSuccess: async (archived) => {
      queryClient.setQueryData(queryKeys.group(group.$id), archived)
      // The button that opened the dialog is gone now: focus goes where the page says. The
      // modal must be gone first, as the page behind it is inert until then.
      flushSync(() => setOpen(false))
      onArchived()
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    },
  })

  if (group.type === 'personal' || group.archivedAt) return null

  function close() {
    // Unmount the modal first: while it's open the page is inert, and focus() does nothing.
    flushSync(() => setOpen(false))
    archive.reset()
    trigger.current?.focus()
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col items-start gap-2 border-t border-border pt-4"
    >
      <h2 id={headingId} className="font-medium">
        Archive group
      </h2>
      <p className="text-sm text-muted-foreground">Stop using this group but keep its history.</p>
      <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
        Archive group
      </Button>
      {open && (
        <ConfirmArchive
          name={name}
          pending={archive.isPending}
          error={archive.error?.message}
          onConfirm={() => archive.mutate()}
          onCancel={close}
        />
      )}
    </section>
  )
}

function ConfirmArchive({
  name,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  name: string
  pending: boolean
  error: string | undefined
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const textId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  // A native modal dialog: the page behind is inert, so focus can't leave it, whatever is
  // clicked. Focus starts on Cancel, the safe choice.
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    cancel.current?.focus()
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      // Esc: React decides, so it can wait while archiving; the dialog closes by unmounting.
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onCancel()
      }}
      // The browser can still close it itself: a second Esc without a click in between can't be
      // cancelled. Reopen while archiving, so the answer has somewhere to show; else it's a Cancel.
      onClose={() => {
        const element = dialog.current
        if (!element || element.open) return
        if (pending) element.showModal()
        else onCancel()
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-md border border-border bg-background p-4 text-foreground backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-lg font-semibold break-words">
          Archive {name}?
        </h2>
        <div id={textId} className="flex flex-col gap-2 text-sm">
          <p>The group becomes read-only. Its schedules, reminders and statements stop.</p>
          <p>Its history stays, and you can still see it.</p>
          <p className="font-medium">This can’t be undone.</p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          {/* aria-disabled, not disabled: a disabled button loses focus. */}
          <Button
            ref={cancel}
            variant="outline"
            aria-disabled={pending}
            onClick={() => !pending && onCancel()}
          >
            Cancel
          </Button>
          <Button aria-disabled={pending} onClick={() => !pending && onConfirm()}>
            {pending ? 'Archiving…' : 'Archive group'}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
