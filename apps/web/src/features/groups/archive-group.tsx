import type { Groups } from '@ledgerly/core/generated/rows'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
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
 * (functions-api.md#groups). Archiving is permanent in v1.
 */
export function ArchiveGroup({ group, onArchived }: { group: Groups; onArchived: () => void }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const archive = useMutation({
    mutationFn: async () => {
      const result = await callFunction<Groups>('groups', 'POST', `/groups/${group.$id}/archive`)
      // Archived meanwhile, say in another tab: the outcome the user asked for. Reload the group,
      // and the page then shows the archived notice.
      if (!result.ok && result.error.code === 'ARCHIVED') return null
      if (!result.ok) throw new Error(writeErrorMessage(result.error))
      return result.data
    },
    onSuccess: async (archived) => {
      if (archived) queryClient.setQueryData(queryKeys.group(group.$id), archived)
      else void queryClient.invalidateQueries({ queryKey: queryKeys.group(group.$id) })
      // The button that opened the dialog is gone now: focus goes where the page says.
      setOpen(false)
      onArchived()
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    },
  })

  if (group.type === 'personal' || group.archivedAt) return null

  function close() {
    setOpen(false)
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
          name={group.name}
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
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  // Focus starts on Cancel, the safe choice.
  useEffect(() => cancel.current?.focus(), [])

  // Esc closes; Tab stays inside the dialog.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const first = buttons[0]
    const last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={onKeyDown}
        className="flex w-full max-w-md flex-col gap-4 rounded-md border border-border bg-background p-4"
      >
        <h2 id={titleId} className="text-lg font-semibold">
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
          {/* aria-disabled, not disabled: a disabled button loses focus, which leaves the dialog. */}
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
    </div>
  )
}
