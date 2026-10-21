import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { type UpdateMemberBody, updateMemberBodySchema } from '@ledgerly/core/schemas/groups'
import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useForm } from 'react-hook-form'
import { schemaResolver } from '../../lib/schema-resolver'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { ArchiveGroup } from '../groups/archive-group'
import { useMemberWrites, useUpdateHouse } from '../house/use-house'
import { InviteForm, inviteSentText } from '../invites/invite-member'
import type { InviteSent } from '../invites/use-send-invite'

type Open = 'name' | 'invite'

/**
 * Managing a lend & borrow group (#403 item 1), for its admins (both people): the other person's
 * name, an invite while they haven't joined (#399), and archiving. The app shows a pair by that
 * name (#145). The group's own `name` is its creator's label for the other person
 * (functions-api.md#groups), which emails such as invites use, so the creator's change renames
 * the group too.
 */
export function PairSettings({
  group,
  them,
  personId,
  focusHeading,
}: {
  group: Groups
  /** The other person's member row. */
  them: Members
  /** The caller's person. */
  personId: string
  focusHeading: () => void
}) {
  const headingId = useId()
  // One form at a time, in place of the button that opened it.
  const [open, setOpen] = useState<Open>()
  const [invited, setInvited] = useState<InviteSent>()
  const buttons = {
    name: useRef<HTMLButtonElement>(null),
    invite: useRef<HTMLButtonElement>(null),
  }
  // identity-and-invites.md#invites: only someone who hasn't joined can be invited.
  const invitable = them.status === 'placeholder'

  function close(from: Open) {
    flushSync(() => setOpen(undefined))
    // A button that's gone (they joined meanwhile) sends focus to Change name.
    ;(buttons[from].current ?? buttons.name.current)?.focus()
  }

  return (
    <>
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-4 border-t border-border pt-4"
      >
        <h2 id={headingId} className="font-medium">
          Settings
        </h2>
        {open === undefined && (
          <div className="flex flex-wrap gap-2">
            <Button ref={buttons.name} variant="outline" onClick={() => setOpen('name')}>
              Change their name
            </Button>
            {invitable && (
              <Button
                ref={buttons.invite}
                variant="outline"
                onClick={() => {
                  setInvited(undefined)
                  setOpen('invite')
                }}
              >
                Invite by email
              </Button>
            )}
          </div>
        )}
        {open === 'name' && (
          <NameForm group={group} them={them} personId={personId} onClose={() => close('name')} />
        )}
        {open === 'invite' && (
          <InviteForm
            group={group}
            member={them}
            personId={personId}
            onSent={(invite) => {
              setInvited(invite)
              close('invite')
            }}
            onCancel={() => close('invite')}
          />
        )}
        {/* Mounted from the start, so the news is read out. */}
        <p role="status" className="text-sm text-muted-foreground empty:sr-only">
          {invited ? inviteSentText(invited) : ''}
        </p>
      </section>
      <ArchiveGroup group={group} name={them.displayName} onArchived={focusHeading} />
    </>
  )
}

/**
 * `PATCH /groups/{id}/members/{memberId}` with their name alone, then, for the group's creator,
 * `PATCH /groups/{id}` with it as the group's `name`. Each only when it changes, so after a
 * failed second write, saving again sends just that one.
 */
function NameForm({
  group,
  them,
  personId,
  onClose,
}: {
  group: Groups
  them: Members
  personId: string
  onClose: () => void
}) {
  const writes = useMemberWrites(group.$id)
  // The groups function's PATCH, which isn't only for houses.
  const rename = useUpdateHouse(group.$id)
  const fieldId = useId()
  const ref = useRef<HTMLFormElement>(null)
  // The button that opened it is gone: focus goes to the field.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus()
  }, [])
  const form = useForm<{ displayName: string }, unknown, UpdateMemberBody>({
    resolver: schemaResolver<{ displayName: string }, UpdateMemberBody>(
      updateMemberBodySchema,
      (values) => ({ displayName: values.displayName }),
    ),
    defaultValues: { displayName: them.displayName },
  })
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async (body) => {
    try {
      const name = body.displayName ?? them.displayName
      if (name !== them.displayName) {
        await writes.update.mutateAsync({ memberId: them.$id, body })
      }
      if (group.ownerPersonId === personId && name !== group.name) {
        await rename.mutateAsync({ name })
      }
      onClose()
    } catch (error) {
      form.setError('root', { message: (error as Error).message })
    }
  })

  return (
    <form
      ref={ref}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // aria-disabled, not disabled, keeps focus on the button; this guard stops a second send.
        if (isSubmitting) event.preventDefault()
        else void submit(event)
      }}
    >
      {errors.root && <Alert variant="destructive">{errors.root.message}</Alert>}
      <TextField
        id={fieldId}
        label="Their name"
        hint="You both see this name for them here."
        error={errors.displayName}
        {...form.register('displayName')}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" aria-disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
        {/* A save that's sent still applies, so Cancel waits for it. */}
        <Button
          type="button"
          variant="outline"
          aria-disabled={isSubmitting}
          onClick={() => !isSubmitting && onClose()}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
