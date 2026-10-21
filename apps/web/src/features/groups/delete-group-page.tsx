import {
  REAUTH_WINDOW_MINUTES,
  RECENT_PASSWORD_CHANGE_HOURS,
} from '@ledgerly/core/constants/limits'
import type { Groups } from '@ledgerly/core/generated/rows'
import type { DeleteGroupRefusal, DeleteGroupResult } from '@ledgerly/core/schemas/identity'
import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import { callFunction, type Err } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { endSession, tryAgainAt } from '../account/delete-account-page'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { groupPath } from './groups-page'
import { useGroupName } from './use-group-name'
import { useGroup, useMyMember } from './use-groups'

/** The groups list's news once a group is deleted, sent in the navigation's state. */
export type GroupDeleted = { name: string; finished: boolean }

/** What the screen says to a refusal: plain words, and whether signing in again is the way on. */
type Refusal = { message: string; signIn?: boolean }

function refusalOf(error: Err['error'], passwordUpdate?: string): Refusal {
  const raw = error.details
  const details = (
    typeof raw === 'object' && raw !== null ? raw : {}
  ) as Partial<DeleteGroupRefusal>
  if (error.code === 'FORBIDDEN' && details.reason === 'reauth') {
    return {
      message: `For your safety, sign in again, then delete the group within ${REAUTH_WINDOW_MINUTES} minutes.`,
      signIn: true,
    }
  }
  // The session is over: the same way on.
  if (error.code === 'UNAUTHENTICATED') return { message: error.message, signIn: true }
  if (error.code === 'FORBIDDEN' && details.reason === 'recent_password_change') {
    return {
      message: `A sign-in detail (your password, email or phone) changed in the last ${RECENT_PASSWORD_CHANGE_HOURS} hours. For your safety, you can delete the group ${tryAgainAt(passwordUpdate)}.`,
    }
  }
  if (error.code === 'VALIDATION_FAILED' && details.reason === 'shared') {
    return {
      message:
        'Someone else is still in this group, so it can’t be deleted: only the last person in it can. That includes anyone who moved out.',
    }
  }
  // Any other refusal in the function's own words: an admin's role, a group that isn't archived
  // or a write that raced (functions-api.md#account).
  return { message: error.message }
}

/**
 * `/groups/:groupId/delete` (#429, identity-and-invites.md#deleting-a-group): what goes, then
 * `account POST /groups/{id}/delete` once DELETE is typed, as the account delete screen does.
 * Linked beside Unarchive (UnarchiveGroup) for an admin, and on its own for the last person in a
 * group with no joined admin (DeleteWithoutAdmin, #486); the function refuses anyone else. Once
 * it's done, on to the groups list, which says so.
 */
export function DeleteGroupPage() {
  const groupId = useParams().groupId ?? ''
  const group = useGroup(groupId)
  if (!group.data) {
    return group.isError ? (
      <Alert variant="destructive">
        We couldn’t load this group. Reload the page to try again.
      </Alert>
    ) : (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  }
  return <DeleteGroup group={group.data} />
}

function DeleteGroup({ group }: { group: Groups }) {
  const user = useCurrentUser().data
  // Their own row, as it was when the page opened (#486): see NOT_A_MEMBER below.
  const personId = useBootstrap(user?.$id ?? '').data?.personId ?? ''
  const mine = useMyMember(group.$id, personId).data
  const name = useGroupName(group)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal>()
  // A delete on its way can't be left: its answer says where to go next.
  useBlocker(busy)
  const confirmed = typed === 'DELETE'
  const path = `/groups/${group.$id}/delete`

  /** Signs out on this device, then back to this screen through the sign-in page. */
  const signInAgain = async () => {
    // A session left behind would make the next sign-in fail.
    if (!(await endSession())) {
      setRefusal({
        message: 'We couldn’t sign you out. Check your connection and try again.',
        signIn: true,
      })
      return
    }
    queryClient.clear()
    queryClient.setQueryData(queryKeys.currentUser, null)
    navigate('/login', { replace: true, state: { from: path } })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !confirmed) return
    setBusy(true)
    setRefusal(undefined)
    const result = await callFunction<DeleteGroupResult>('account', 'POST', path, {
      confirm: 'DELETE',
    })
    // NOT_A_MEMBER is done too. An admin's row goes last, so for them the delete has finished.
    // Someone who moved out needs the team, which goes first, so the hourly job may still be
    // removing the rest (#486).
    if (!result.ok && result.error.code !== 'NOT_A_MEMBER') {
      setBusy(false)
      setRefusal(refusalOf(result.error, user?.passwordUpdate))
      return
    }
    const finished = result.ok ? result.data.finished : mine?.status !== 'left'
    const deleted: GroupDeleted = { name, finished }
    const groups = queryKeys.groups(user?.$id ?? '')
    // Off the cached list first, which the groups list shows while it's read again.
    queryClient.setQueryData<Groups[]>(groups, (old) => old?.filter(({ $id }) => $id !== group.$id))
    // Unblocked first: the blocker reads `busy` as last rendered.
    flushSync(() => setBusy(false))
    navigate('/groups', { replace: true, state: deleted })
    // Then everything read for the group (each key has its ID second): read again, it fails, and
    // the cached group would stay on its own page, Back to it included.
    queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[1] === group.$id })
    // Its team is gone, so the list no longer has it.
    await queryClient.invalidateQueries({ queryKey: groups })
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        {!busy && (
          <Link
            to={groupPath(group) ?? '/groups'}
            className="self-start text-sm underline underline-offset-4"
          >
            Back to the group
          </Link>
        )}
        <h1 className="text-2xl font-semibold break-words">Delete {name}</h1>
        <p>There’s no undo. Read what goes first.</p>
      </div>
      <section aria-labelledby="goes" className="flex flex-col gap-2">
        <h2 id="goes" className="text-lg font-semibold">
          What’s deleted
        </h2>
        <ul className="list-disc pl-5 text-sm">
          <li>Everything recorded in it, with its receipts.</li>
          <li>Its statements and invoices, final ones included.</li>
          <li>Its members, its activity, and the invites and reminders sent in it.</li>
        </ul>
        <p className="text-sm">
          A receipt that’s also on another group’s records stays there. The group is deleted with
          its invoices, so{' '}
          <Link to="/export" className="underline underline-offset-4">
            export its records
          </Link>{' '}
          first if you need them.
        </p>
      </section>
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {refusal && (
          <Alert variant="destructive">
            <div className="flex flex-col gap-2">
              <p>{refusal.message}</p>
              {refusal.signIn && (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={() => void signInAgain()}
                >
                  Sign in again
                </Button>
              )}
            </div>
          </Alert>
        )}
        <TextField
          id="confirmDelete"
          label="Type DELETE to confirm"
          autoComplete="off"
          autoCapitalize="characters"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button
          type="submit"
          className="self-start"
          aria-disabled={busy || !confirmed}
          aria-describedby={confirmed ? undefined : 'delete-waits'}
        >
          {busy ? 'Deleting…' : 'Delete group'}
        </Button>
        {!confirmed && (
          <p id="delete-waits" className="text-sm text-muted-foreground">
            Type DELETE above first.
          </p>
        )}
        <p role="status" className="sr-only">
          {busy ? 'Deleting the group…' : ''}
        </p>
      </form>
    </div>
  )
}
