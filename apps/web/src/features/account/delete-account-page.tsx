import {
  REAUTH_WINDOW_MINUTES,
  RECENT_PASSWORD_CHANGE_HOURS,
} from '@ledgerly/core/constants/limits'
import type { Groups } from '@ledgerly/core/generated/rows'
import type { DeleteAccountRefusal, DeleteAccountResult } from '@ledgerly/core/schemas/identity'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { AppwriteException } from 'appwrite'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useBlocker, useNavigate } from 'react-router'
import { callFunction, type Err } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useAllBalances } from '../dashboard/use-dashboard'
import { GroupName } from '../groups/use-group-name'
import { useGroups } from '../groups/use-groups'

const PATH = '/account/delete'

/** What the screen says to a refusal: plain words, and whether signing in again is the way on. */
type Refusal = { message: string; groupIds?: string[]; signIn?: boolean }

/**
 * When a sign-in detail changed at `passwordUpdate` is old enough to delete, in words. A time not
 * in the future (a change made on another device since) gets the general wording. The group
 * delete screen says it too.
 */
export function tryAgainAt(passwordUpdate: string | undefined): string {
  const changed = passwordUpdate ? Date.parse(passwordUpdate) : Number.NaN
  const at = changed + RECENT_PASSWORD_CHANGE_HOURS * 60 * 60 * 1000
  if (Number.isNaN(changed) || at <= Date.now()) {
    return `${RECENT_PASSWORD_CHANGE_HOURS} hours after that change`
  }
  return `from ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)}`
}

export function refusalOf(error: Err['error'], passwordUpdate?: string): Refusal {
  const raw = error.details
  const details = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
    DeleteAccountRefusal & { groupIds: string[] }
  >
  const reason = 'reason' in details ? details.reason : undefined
  if (error.code === 'FORBIDDEN' && reason === 'reauth') {
    return {
      message: `For your safety, sign in again, then delete your account within ${REAUTH_WINDOW_MINUTES} minutes.`,
      signIn: true,
    }
  }
  if (error.code === 'FORBIDDEN' && reason === 'recent_password_change') {
    // Appwrite moves `passwordUpdate` when an account without a password changes its email or phone.
    return {
      message: `A sign-in detail (your password, email or phone) changed in the last ${RECENT_PASSWORD_CHANGE_HOURS} hours. For your safety, you can delete your account ${tryAgainAt(passwordUpdate)}.`,
    }
  }
  if (error.code === 'VALIDATION_FAILED' && Array.isArray(details.groupIds)) {
    return {
      message:
        'You’re the only admin of these houses. Make someone else admin first, so they can keep running them:',
      groupIds: details.groupIds,
    }
  }
  // Any other refusal in the function's own words: CONFLICT alone means a running timer, a
  // statement being finalized, or a write that raced (functions-api.md#account), and only the
  // message tells them apart.
  return { message: error.message }
}

/** Ends this device's session: false when that failed for any reason but its being gone already. */
export async function endSession(): Promise<boolean> {
  try {
    await account.deleteSession({ sessionId: 'current' })
    return true
  } catch (error) {
    return error instanceof AppwriteException && error.code === 401
  }
}

/**
 * Drops all of a maybe-deleted account from this browser: the cache, its onboarding flag, and the
 * SDK's copy of the session, which `deleteSession` can't remove once the server has.
 */
function forget(queryClient: QueryClient, userId: string) {
  queryClient.clear()
  queryClient.setQueryData(queryKeys.currentUser, null)
  try {
    localStorage.removeItem(`ledgerly:onboarding-hidden:${userId}`)
    localStorage.removeItem('cookieFallback')
  } catch {
    // Storage blocked: nothing was kept there.
  }
}

/**
 * `/account/delete` (#50, identity-and-invites.md#deleting-an-account-m4): what goes and what
 * stays, then `account POST /delete` once DELETE is typed. Mounted outside the signed-in layout,
 * so the "deleted" message can stay on screen once there's no user.
 */
export function DeleteAccountPage() {
  const user = useCurrentUser()
  const [deleted, setDeleted] = useState<DeleteAccountResult>()
  // The answer was UNAUTHENTICATED: maybe deleted, so nothing of the account's stays mounted.
  const [unconfirmed, setUnconfirmed] = useState(false)
  if (deleted) return <Deleted result={deleted} />
  if (unconfirmed) return <Unconfirmed />
  if (user.isPending) {
    return (
      <Page>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </Page>
    )
  }
  if (!user.data) {
    if (user.isError) {
      return (
        <Page>
          <Alert variant="destructive">
            We couldn’t reach Ledgerly. Check your connection and reload the page.
          </Alert>
        </Page>
      )
    }
    return <Navigate to="/login" replace state={{ from: PATH }} />
  }
  return (
    <DeleteAccount
      userId={user.data.$id}
      passwordUpdate={user.data.passwordUpdate}
      onDeleted={setDeleted}
      onUnconfirmed={() => setUnconfirmed(true)}
    />
  )
}

function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">{children}</main>
}

function DeleteAccount({
  userId,
  passwordUpdate,
  onDeleted,
  onUnconfirmed,
}: {
  userId: string
  passwordUpdate: string | undefined
  onDeleted: (result: DeleteAccountResult) => void
  onUnconfirmed: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const groups = useGroups()
  // Set up first: a bootstrap still on its way when the deletion starts could make a new person.
  const bootstrap = useBootstrap(userId)
  const personId = bootstrap.data?.personId ?? ''
  const balances = useAllBalances(groups.data ?? [])
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal>()
  // A deletion on its way can't be left: its answer is what says whether the account is gone.
  useBlocker(busy)
  const confirmed = typed === 'DELETE'
  const checking = !bootstrap.data || !groups.data || balances.some((balance) => balance.isPending)
  const failed = bootstrap.isError || groups.isError
  const ready = confirmed && !checking

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
    navigate('/login', { replace: true, state: { from: PATH } })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setRefusal(undefined)
    const result = await callFunction<DeleteAccountResult>('account', 'POST', '/delete', {
      confirm: 'DELETE',
    })
    if (!result.ok && result.error.code !== 'UNAUTHENTICATED') {
      setBusy(false)
      setRefusal(refusalOf(result.error, passwordUpdate))
      return
    }
    // Deleted, or maybe: past the point of no return the sessions go, so an UNAUTHENTICATED can't
    // tell. This form unmounts first, so no query of the account's runs again (a bootstrap now
    // could make a new person), then nothing of the account's stays in the browser.
    if (result.ok) onDeleted(result.data)
    else onUnconfirmed()
    forget(queryClient, userId)
    if (result.ok) void endSession()
  }

  return (
    <Page>
      <div className="flex flex-col gap-2">
        {!busy && (
          <Link to="/profile" className="self-start text-sm underline underline-offset-4">
            Back to your profile
          </Link>
        )}
        <h1 className="text-2xl font-semibold">Delete your account</h1>
        <p>There’s no undo. Read what goes and what stays first.</p>
      </div>
      <section aria-labelledby="goes" className="flex flex-col gap-2">
        <h2 id="goes" className="text-lg font-semibold">
          What’s deleted
        </h2>
        <ul className="list-disc pl-5 text-sm">
          <li>Your login, and the email and phone on your account.</li>
          <li>
            Your profile and business details. Statements already issued keep the details printed on
            them.
          </li>
          <li>
            Your personal records, and every group nobody else is in, with its receipts, statements
            and invoices.
          </li>
          <li>Invites you sent.</li>
        </ul>
      </section>
      <section aria-labelledby="stays" className="flex flex-col gap-2">
        <h2 id="stays" className="text-lg font-semibold">
          What stays, in groups shared with others
        </h2>
        <ul className="list-disc pl-5 text-sm">
          <li>Your history, under the name “Former member”, so everyone’s balances stay right.</li>
          <li>Statements and invoices already issued, as they were issued.</li>
          <li>Receipts on their transactions, whoever added them, and notes others wrote.</li>
          <li>The activity already recorded.</li>
        </ul>
        <p className="text-sm">
          Groups nobody else is in are deleted with their invoices, so{' '}
          <Link to="/export" className="underline underline-offset-4">
            export your data
          </Link>{' '}
          first if you need it.
        </p>
      </section>
      {failed ? (
        <Alert variant="destructive">
          We couldn’t check your groups and balances. Reload the page to try again.
        </Alert>
      ) : checking ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your balances…
        </p>
      ) : (
        <OpenBalances groups={groups.data ?? []} personId={personId} balances={balances} />
      )}
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {refusal && <RefusalNotice refusal={refusal} groups={groups.data} onSignIn={signInAgain} />}
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
          aria-disabled={busy || !ready}
          aria-describedby={ready ? undefined : 'delete-waits'}
        >
          {busy ? 'Deleting…' : 'Delete my account'}
        </Button>
        {!ready && (
          <p id="delete-waits" className="text-sm text-muted-foreground">
            {checking ? 'This waits until your balances are checked.' : 'Type DELETE above first.'}
          </p>
        )}
        <p role="status" className="sr-only">
          {busy ? 'Deleting your account…' : ''}
        </p>
      </form>
    </Page>
  )
}

/** Groups where the user is owed, or owes: deleting doesn't settle them. */
function OpenBalances({
  groups,
  personId,
  balances,
}: {
  groups: Groups[]
  personId: string
  balances: ReturnType<typeof useAllBalances>
}) {
  const open = groups.filter((_group, index) => {
    const people = balances[index]?.data?.people ?? []
    return people.some((person) => person.personId === personId && person.netCents !== 0)
  })
  const unknown = groups.filter((_group, index) => balances[index]?.isError)
  if (open.length === 0 && unknown.length === 0) return null
  return (
    <section aria-labelledby="balances" className="flex flex-col gap-2">
      <h2 id="balances" className="text-lg font-semibold">
        Balances not settled
      </h2>
      {open.length > 0 && (
        <>
          <p className="text-sm">
            You still owe, or are owed, in these groups. Deleting doesn’t settle them: the others
            will still see what’s owed.
          </p>
          <ul className="list-disc pl-5 text-sm">
            {open.map((group) => (
              <li key={group.$id} className="break-words">
                <GroupName group={group} />
              </li>
            ))}
          </ul>
        </>
      )}
      {unknown.length > 0 && (
        <>
          <p className="text-sm">We couldn’t check your balance in these groups:</p>
          <ul className="list-disc pl-5 text-sm">
            {unknown.map((group) => (
              <li key={group.$id} className="break-words">
                <GroupName group={group} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function RefusalNotice({
  refusal,
  groups,
  onSignIn,
}: {
  refusal: Refusal
  groups: Groups[] | undefined
  onSignIn: () => void
}) {
  const byId = new Map((groups ?? []).map((group) => [group.$id, group]))
  return (
    <Alert variant="destructive">
      <div className="flex flex-col gap-2">
        <p>{refusal.message}</p>
        {refusal.groupIds && (
          <ul className="list-disc pl-5">
            {refusal.groupIds.map((id) => {
              const group = byId.get(id)
              return (
                <li key={id} className="break-words">
                  {group ? <GroupName group={group} /> : 'A house'}
                </li>
              )
            })}
          </ul>
        )}
        {refusal.signIn && (
          <Button type="button" variant="outline" className="self-start" onClick={onSignIn}>
            Sign in again
          </Button>
        )}
      </div>
    </Alert>
  )
}

function Unconfirmed() {
  const navigate = useNavigate()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const [failed, setFailed] = useState(false)
  const signIn = async () => {
    // A session left behind would make the next sign-in fail.
    if (!(await endSession())) {
      setFailed(true)
      return
    }
    navigate('/login', { replace: true, state: { from: PATH } })
  }
  return (
    <Page>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        We couldn’t confirm the deletion
      </h1>
      <p>Sign in again: if your account is gone, signing in won’t work.</p>
      {failed && (
        <Alert variant="destructive">
          We couldn’t sign you out. Check your connection and try again.
        </Alert>
      )}
      <Button type="button" className="self-start" onClick={() => void signIn()}>
        Sign in again
      </Button>
    </Page>
  )
}

function Deleted({ result }: { result: DeleteAccountResult }) {
  // The form and its button are gone: focus goes to the news.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <Page>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        Your account was deleted
      </h1>
      <p>
        {result.finished
          ? 'Everything listed is gone.'
          : 'The rest of what’s listed is removed within the hour.'}{' '}
        You’ve been signed out on every device.
      </p>
      <Link to="/signup" className="self-start underline underline-offset-4">
        Create a new account
      </Link>
    </Page>
  )
}
