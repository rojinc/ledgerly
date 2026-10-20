import type { Groups, Members } from '@ledgerly/core/generated/rows'
import type { UpdateGroupBody } from '@ledgerly/core/schemas/groups'
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import {
  ARCHIVED_NOTICE,
  ArchiveGroup,
  UNARCHIVED_NEWS,
  UnarchiveGroup,
} from '../groups/archive-group'
import { useGroup, useMyMember } from '../groups/use-groups'
import { InviteForm, inviteSentText } from '../invites/invite-member'
import type { InviteSent } from '../invites/use-send-invite'
import { useMembers } from '../transactions/use-transactions'
import { HouseForm } from './house-form'
import { HouseHistory } from './house-history'
import {
  type HouseValues,
  memberStatusText,
  REMOVE_REFUSED,
  ROLE_LABEL,
  toHouseValues,
} from './house-values'
import { AddHousemate, EditMember, MoveBackIn, MoveOut } from './housemate-forms'
import { SettleUp } from './settle-up'
import { GroupsError, useLeaveHouse, useMemberWrites, useUpdateHouse } from './use-house'

function Message({ children, alert = false }: { children: string; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={alert ? 'text-destructive' : 'text-muted-foreground'}
    >
      {children}
    </p>
  )
}

/** Where a group that isn't a house has its page. */
function pageOf(group: Groups): string {
  if (group.type === 'employer') return `/groups/${group.$id}/settings`
  if (group.type === 'pair') return `/people/${group.$id}`
  return '/groups'
}

/** `/groups/:groupId` for a house: who lives there, and what each role can change. */
export function HousePage() {
  const groupId = useParams().groupId ?? ''
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const group = useGroup(groupId)
  const me = useMyMember(groupId, personId)
  const members = useMembers(groupId)
  const heading = useRef<HTMLHeadingElement>(null)

  if (group.data && group.data.type !== 'house') return <Navigate to={pageOf(group.data)} replace />

  let content: ReactNode
  // Errors only when there's nothing to show: a failed background refetch keeps the page.
  if (
    (group.isError && !group.data) ||
    (me.isError && me.data === undefined) ||
    (members.isError && !members.data)
  ) {
    content = <Message alert>We couldn’t load this house. Reload the page to try again.</Message>
  } else if (!group.data || me.data === undefined || !members.data) {
    content = <Message>Loading…</Message>
  } else {
    content = <House group={group.data} me={me.data} members={members.data} heading={heading} />
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold break-words outline-none">
        {group.data?.name ?? 'House'}
      </h1>
      {content}
    </div>
  )
}

function House({
  group,
  me,
  members,
  heading,
}: {
  group: Groups
  me: Members | null
  members: Members[]
  heading: RefObject<HTMLHeadingElement | null>
}) {
  const writes = useMemberWrites(group.$id)
  const archived = Boolean(group.archivedAt)
  // permissions.md#roles. An archived house is read-only for everyone (#37).
  const role = archived ? undefined : me?.role
  const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName))
  // A button that goes away takes focus with it: focus goes to the heading instead.
  const focusHeading = () => heading.current?.focus()
  // The caller's role can change while the page is open (their own change, another admin's, or
  // a refused write that reloads it), and the house can be archived. The forms and buttons that
  // go with the old role are gone, with any refusal they showed: say so, and focus the heading.
  const [newRole, setNewRole] = useState<Members['role']>()
  const [unarchived, setUnarchived] = useState(false)
  const lastRole = useRef(role)
  useEffect(() => {
    if (lastRole.current === role) return
    if (lastRole.current && role) setNewRole(role)
    lastRole.current = role
    if (document.activeElement === document.body) heading.current?.focus()
  }, [role, heading])

  return (
    <>
      {archived && <Message>{ARCHIVED_NOTICE}</Message>}
      {/* `role` is unset while it's archived: the stored role says who may unarchive. */}
      {archived && me?.role === 'admin' && (
        <UnarchiveGroup
          group={group}
          onUnarchived={() => {
            setUnarchived(true)
            focusHeading()
          }}
        />
      )}
      {/* Mounted from the start, so the announcement is read out when it changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {newRole && `Your role here is now ${ROLE_LABEL[newRole]}.`}
      </p>
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {unarchived && !archived ? UNARCHIVED_NEWS : ''}
      </p>
      {/* #180. `role` is unset in an archived house. */}
      {(role === 'admin' || role === 'member') && (
        <Link
          to={`/transactions/new?groupId=${group.$id}`}
          className="inline-flex h-10 items-center self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Add expense
        </Link>
      )}
      {/* #166: the house's monthly divides, for everyone in it. */}
      <Link
        to={`/groups/${group.$id}/statements`}
        className="self-start text-sm underline underline-offset-4"
      >
        Statements
      </Link>
      {/* #44: every role reads the house's bills. */}
      <Link
        to={`/bills?groupId=${group.$id}`}
        className="self-start text-sm underline underline-offset-4"
      >
        Bills
      </Link>
      <section aria-labelledby="housemates" className="flex flex-col gap-2">
        <h2 id="housemates" className="font-medium">
          Housemates
        </h2>
        <ul className="divide-y divide-border rounded-md border border-border">
          {sorted.map((member) => (
            <MemberRow
              key={member.$id}
              group={group}
              member={member}
              isMe={member.personId === me?.personId}
              isAdmin={role === 'admin'}
              // permissions.md#roles: in a house, members send invites too.
              invitedBy={role === 'admin' || role === 'member' ? me?.personId : undefined}
              writes={writes}
              focusHeading={focusHeading}
            />
          ))}
        </ul>
      </section>
      {(role === 'admin' || role === 'member') && (
        <AddHousemate group={group} isAdmin={role === 'admin'} writes={writes} />
      )}
      <SettleUp group={group} me={me} members={members} />
      <HouseHistory
        group={group}
        members={members}
        canAdd={role === 'admin' || role === 'member'}
      />
      {/* Someone who moved out is still in the team until they leave (permissions.md). */}
      {!archived && me && me.status !== 'placeholder' && <LeaveHouse group={group} />}
      {role === 'admin' && <HouseSettings group={group} />}
      {role === 'admin' && <ArchiveGroup group={group} onArchived={focusHeading} />}
    </>
  )
}

type Mode = 'view' | 'edit' | 'moveOut' | 'moveBackIn' | 'remove' | 'invite'

function MemberRow({
  group,
  member,
  isMe,
  isAdmin,
  invitedBy,
  writes,
  focusHeading,
}: {
  group: Groups
  member: Members
  isMe: boolean
  isAdmin: boolean
  /** The caller's person, when they may invite. */
  invitedBy: string | undefined
  writes: ReturnType<typeof useMemberWrites>
  focusHeading: () => void
}) {
  const [chosen, setMode] = useState<Mode>('view')
  const [invited, setInvited] = useState<InviteSent>()
  // Every row has the same three buttons: each one is described by its housemate's name.
  const nameId = useId()
  // An open form closes when the caller stops being an admin, or the house is archived; the
  // invite form when they can no longer invite. It stays if the row changes meanwhile (they
  // joined), so a send under way or its refusal isn't lost.
  const mode = chosen === 'invite' ? (invitedBy ? chosen : 'view') : isAdmin ? chosen : 'view'
  // identity-and-invites.md#invites: only someone who hasn't joined can be invited.
  const invitable = invitedBy !== undefined && member.status === 'placeholder'
  const buttons = {
    edit: useRef<HTMLButtonElement>(null),
    // One button moves them out or back in, whichever applies now.
    move: useRef<HTMLButtonElement>(null),
    remove: useRef<HTMLButtonElement>(null),
    invite: useRef<HTMLButtonElement>(null),
  }

  function close(from: Exclude<Mode, 'view'>) {
    flushSync(() => setMode('view'))
    const trigger = from === 'moveOut' || from === 'moveBackIn' ? buttons.move : buttons[from]
    // A button that's gone sends focus to Change, or with none (a member's row), to the heading.
    const target = trigger.current ?? buttons.edit.current
    if (target) target.focus()
    else focusHeading()
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="min-w-0">
        <p id={nameId} className="font-medium break-words">
          {member.displayName}
          {isMe && ' (you)'}
        </p>
        <p className="text-sm text-muted-foreground">
          {ROLE_LABEL[member.role]} · {memberStatusText(member)}
        </p>
      </div>
      {isAdmin && mode === 'view' && (
        <div className="flex flex-wrap gap-2">
          <Button
            ref={buttons.edit}
            variant="outline"
            aria-describedby={nameId}
            onClick={() => setMode('edit')}
          >
            Change
          </Button>
          {member.leftOn ? (
            <Button
              ref={buttons.move}
              variant="outline"
              aria-describedby={nameId}
              onClick={() => setMode('moveBackIn')}
            >
              Moved back in
            </Button>
          ) : (
            <Button
              ref={buttons.move}
              variant="outline"
              aria-describedby={nameId}
              onClick={() => setMode('moveOut')}
            >
              Moved out
            </Button>
          )}
          {/* Your own way out is Leave this house, which checks your balance. */}
          {!isMe && (
            <Button
              ref={buttons.remove}
              variant="outline"
              aria-describedby={nameId}
              onClick={() => setMode('remove')}
            >
              Remove
            </Button>
          )}
        </div>
      )}
      {mode === 'edit' && (
        <EditMember member={member} writes={writes} onClose={() => close('edit')} />
      )}
      {mode === 'moveOut' && (
        <MoveOut group={group} member={member} writes={writes} onClose={() => close('moveOut')} />
      )}
      {mode === 'moveBackIn' && (
        <MoveBackIn member={member} writes={writes} onClose={() => close('moveBackIn')} />
      )}
      {mode === 'remove' && (
        <ConfirmRemove
          member={member}
          writes={writes}
          onCancel={() => close('remove')}
          onRemoved={focusHeading}
        />
      )}
      {invitable && mode === 'view' && (
        <Button
          ref={buttons.invite}
          variant="outline"
          className="self-start"
          aria-describedby={nameId}
          onClick={() => {
            setInvited(undefined)
            setMode('invite')
          }}
        >
          Invite by email
        </Button>
      )}
      {mode === 'invite' && invitedBy && (
        <InviteForm
          group={group}
          member={member}
          personId={invitedBy}
          onSent={(invite) => {
            setInvited(invite)
            close('invite')
          }}
          onCancel={() => close('invite')}
        />
      )}
      {/* Mounted with the button, so the news is read out. */}
      {invitable && (
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {invited ? inviteSentText(invited) : ''}
        </p>
      )}
    </li>
  )
}

function ConfirmRemove({
  member,
  writes,
  onCancel,
  onRemoved,
}: {
  member: Members
  writes: ReturnType<typeof useMemberWrites>
  onCancel: () => void
  onRemoved: () => void
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    setError('')
    try {
      await writes.remove.mutateAsync(member.$id)
      // The row is gone with this button in it.
      onRemoved()
    } catch (failure) {
      setError(
        failure instanceof GroupsError && failure.code === 'VALIDATION_FAILED'
          ? REMOVE_REFUSED
          : (failure as Error).message,
      )
      setPending(false)
    }
  }

  return (
    <Confirm
      text={`Remove ${member.displayName} from this house? Only someone with no money or schedules here can be removed.`}
      action="Remove"
      pendingAction="Removing…"
      pending={pending}
      error={error}
      onConfirm={remove}
      onCancel={onCancel}
    />
  )
}

/** An inline "are you sure", with focus on Cancel, the safe choice. */
function Confirm({
  text,
  action,
  pendingAction,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  text: ReactNode
  action: string
  pendingAction: string
  pending: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const textId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div id={textId} className="flex flex-col gap-1 text-sm">
        {text}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {/* aria-disabled, not disabled: a disabled button loses focus. */}
        <Button
          aria-describedby={textId}
          aria-disabled={pending}
          onClick={() => !pending && onConfirm()}
        >
          {pending ? pendingAction : action}
        </Button>
        <Button
          ref={cancel}
          aria-describedby={textId}
          variant="outline"
          aria-disabled={pending}
          onClick={() => !pending && onCancel()}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * `POST /groups/{id}/leave`: final for this membership (permissions.md#leaving-a-group). The
 * function refuses while their balance isn't 0, and says so.
 */
function LeaveHouse({ group }: { group: Groups }) {
  const headingId = useId()
  const navigate = useNavigate()
  const leave = useLeaveHouse(group.$id)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col items-start gap-2 border-t border-border pt-4"
    >
      <h2 id={headingId} className="font-medium">
        Leave this house
      </h2>
      {open ? (
        <Confirm
          text={
            <>
              <p>Your balance here must be 0 first: settle up before you leave.</p>
              <p className="font-medium">Leaving is final: you can’t come back to this house.</p>
            </>
          }
          action="Leave this house"
          pendingAction="Leaving…"
          pending={leave.isPending}
          error={leave.error?.message ?? ''}
          // Only while this page is open: a leave that ends after the caller moved on leaves them be.
          onConfirm={() => leave.mutate(undefined, { onSuccess: () => navigate('/groups') })}
          onCancel={() => {
            flushSync(() => setOpen(false))
            leave.reset()
            trigger.current?.focus()
          }}
        />
      ) : (
        <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
          Leave this house
        </Button>
      )}
    </section>
  )
}

/** `PATCH /groups/{id}` (admins). */
function HouseSettings({ group }: { group: Groups }) {
  const headingId = useId()
  const update = useUpdateHouse(group.$id)
  const values = toHouseValues(group)

  async function save(body: UpdateGroupBody): Promise<HouseValues> {
    const stored = toHouseValues(await update.mutateAsync(body))
    if (!stored) throw new Error('Saved, but the settings couldn’t be read back. Reload the page.')
    return stored
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 border-t border-border pt-4"
    >
      <h2 id={headingId} className="font-medium">
        Settings
      </h2>
      {values ? (
        <HouseForm mode="settings" defaultValues={values} stored={values} onSave={save} />
      ) : (
        // A form with defaults would overwrite what's stored.
        <Message alert>
          We couldn’t read this house’s settings, so they can’t be changed here.
        </Message>
      )}
    </section>
  )
}
