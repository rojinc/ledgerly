import type { Groups } from '@ledgerly/core/generated/rows'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'react-router'
import { callFunction, type Err } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { cn } from '../../lib/utils'
import { Button, buttonVariants } from '../../ui/button'
import { useCurrentUser } from '../auth/use-current-user'
import { useMembers } from '../transactions/use-transactions'

/** Shown on every page of an archived group (#37). */
export const ARCHIVED_NOTICE = 'This group is archived. You can see its history but not change it.'

/** The page's news once an admin has unarchived the group (#428). */
export const UNARCHIVED_NEWS = 'This group is unarchived, so it can be changed again.'

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
 * (functions-api.md#groups). An admin can unarchive it again (UnarchiveGroup). `name` is the
 * group as the page shows it: a pair by its other person, not by its creator's label (#145).
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
        <Confirm
          title={`Archive ${name}?`}
          action="Archive group"
          pendingAction="Archiving…"
          pending={archive.isPending}
          error={archive.error?.message}
          onConfirm={() => archive.mutate()}
          onCancel={close}
        >
          <p>The group becomes read-only. Its schedules, reminders and statements stop.</p>
          <p>Its history stays, and you can still see it. An admin can unarchive it later.</p>
        </Confirm>
      )}
    </section>
  )
}

/**
 * `groups POST /groups/{id}/unarchive` (functions-api.md#groups): the group as stored goes in the
 * cache, so the page turns writable at once, then `onUnarchived` runs, then the groups list is
 * read again. A refusal throws the function's message in plain words.
 */
export function useUnarchiveGroup(groupId: string, onUnarchived: () => void) {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      // The server answers a repeat with the group, so a retry after a lost answer is fine.
      const result = await callFunction<Groups>('groups', 'POST', `/groups/${groupId}/unarchive`)
      if (!result.ok) throw new Error(writeErrorMessage(result.error))
      return result.data
    },
    onSuccess: async (unarchived) => {
      queryClient.setQueryData(queryKeys.group(groupId), unarchived)
      // Here, not in mutate's own callbacks, which never run once their component is gone: the
      // button goes as the page turns writable.
      onUnarchived()
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    },
  })
}

/**
 * Unarchive behind a confirmation, for an admin of an archived group (#428), next to its
 * archived notice; the page decides who sees it. `onUnarchived` says so on the page and moves
 * focus there, since the button goes. `name` as for ArchiveGroup. Beside it, Delete group (#429)
 * links to its screen (DeleteGroupPage) while nobody else is in the group.
 */
export function UnarchiveGroup({
  group,
  name = group.name,
  onUnarchived,
}: {
  group: Groups
  name?: string
  onUnarchived: () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const unarchive = useUnarchiveGroup(group.$id, () => {
    // The modal must be gone first, as the page behind it is inert until then.
    flushSync(() => setOpen(false))
    onUnarchived()
  })
  // The app can't see the team. Someone else whose row is `active` has joined, so is in it
  // (permissions.md#teams), and the delete would be refused; the admin's own row is the other
  // `active` one. Anyone else in it (someone who moved out) gets the delete's own refusal.
  const members = useMembers(group.$id)
  const alone =
    members.data !== undefined &&
    members.data.filter((member) => member.status === 'active').length <= 1

  function close() {
    flushSync(() => setOpen(false))
    unarchive.reset()
    trigger.current?.focus()
  }

  return (
    <>
      <div className="flex flex-col items-start">
        <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
          Unarchive group
        </Button>
        {open && (
          <Confirm
            title={`Unarchive ${name}?`}
            action="Unarchive group"
            pendingAction="Unarchiving…"
            pending={unarchive.isPending}
            error={unarchive.error?.message}
            onConfirm={() => unarchive.mutate()}
            onCancel={close}
          >
            <p>The group can be changed again. Nothing in its history changes.</p>
            <p>
              Schedules stopped while it was archived stay stopped until they’re restarted or
              changed.
            </p>
          </Confirm>
        )}
      </div>
      {alone && <DeleteLink group={group} />}
    </>
  )
}

/**
 * Delete group for the last person in an archived group with no joined admin (no `active` row
 * with the role `admin`), whatever their role (#486): nobody can unarchive it, so it's the only
 * way out. The page shows it to anyone but an admin, who gets UnarchiveGroup instead. So, as for
 * the admin's, it's shown only while nobody else's row is `active`, which also means nobody else
 * is a joined admin, and only to someone whose own row says they joined.
 */
export function DeleteWithoutAdmin({ group, personId }: { group: Groups; personId: string }) {
  const members = useMembers(group.$id)
  const why = useId()
  const rows = members.data
  const mine = rows?.find((row) => row.personId === personId)
  if (
    rows === undefined ||
    !mine ||
    mine.status === 'placeholder' ||
    rows.some((row) => row.status === 'active' && row.personId !== personId)
  ) {
    return null
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p id={why} className="text-sm text-muted-foreground">
        This group has no admin any more, so you can delete it.
      </p>
      <DeleteLink group={group} describedBy={why} />
    </div>
  )
}

function DeleteLink({ group, describedBy }: { group: Groups; describedBy?: string }) {
  return (
    <Link
      to={`/groups/${group.$id}/delete`}
      aria-describedby={describedBy}
      className={cn(buttonVariants({ variant: 'outline' }), 'self-start')}
    >
      Delete group
    </Link>
  )
}

/** A confirmation in a native modal dialog, for archiving and unarchiving. */
function Confirm({
  title,
  children,
  action,
  pendingAction,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  action: string
  pendingAction: string
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
      // Esc: React decides, so it can wait while sending; the dialog closes by unmounting.
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onCancel()
      }}
      // The browser can still close it itself: a second Esc without a click in between can't be
      // cancelled. Reopen while sending, so the answer has somewhere to show; else it's a Cancel.
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
          {title}
        </h2>
        <div id={textId} className="flex flex-col gap-2 text-sm">
          {children}
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
            {pending ? pendingAction : action}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
