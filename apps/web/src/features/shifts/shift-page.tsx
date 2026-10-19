import { isLocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { transactionTemplateSchema } from '@ledgerly/core/schemas/ledger'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { centsToText } from '../groups/employer-form'
import { useGroup, useGroups, useMyMember } from '../groups/use-groups'
import { LedgerError, useTransaction } from '../transactions/use-transactions'
import { ShiftForm } from './shift-form'
import { type ShiftValues, toShiftValues } from './shift-values'
import { markStale, useConfirmShift, useMyRoles, useSaveShift, useVoidShift } from './use-shifts'

/** The group's default hourly rate as text, or empty when it has none. */
export function defaultRate(group: Groups): string {
  try {
    const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
    return settings.type === 'employer'
      ? centsToText(settings.defaultRateCents, group.currency)
      : ''
  } catch {
    return ''
  }
}

// The stored input's shift, or undefined if it can't be read (then the shift isn't editable here).
function storedShift(inputJson: string) {
  try {
    const stored = transactionTemplateSchema.safeParse(JSON.parse(inputJson))
    return stored.success ? stored.data.shift : undefined
  } catch {
    return undefined
  }
}

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={alert ? 'text-destructive' : 'text-muted-foreground'}
    >
      {children}
    </p>
  )
}

/** `/shifts/new?groupId=&date=`: a shift in one of the user's employer groups. */
export function NewShiftPage() {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const groups = useGroups()
  const open = groups.data?.filter((group) => group.type === 'employer' && !group.archivedAt)
  const roles = useMyRoles(open, personId)
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const save = useSaveShift()
  // One ID per visit, so retrying after an error can't add the shift twice.
  const [id] = useState(() => ID.unique())

  // The same ID again with different content: an earlier try was saved although its answer was
  // lost, and the form changed since. Open the shift as saved, rather than refusing forever.
  async function openSaved(error: unknown) {
    if (!(error instanceof LedgerError && error.code === 'CONFLICT')) throw error
    const row = await tablesDB
      .getRow<Transactions>({ databaseId: DATABASE_ID, tableId: 'transactions', rowId: id })
      .catch(() => {
        throw error
      })
    // Only the shift this visit sent: the caller's own, in a shift's shape.
    if (row.createdBy !== personId || row.kind !== 'shift') throw error
    queryClient.setQueryData(queryKeys.transaction(id), row)
    // The lost answer's refresh never ran.
    markStale(queryClient, row.groupId)
    navigate(`/shifts/${id}`, { replace: true, state: { alreadySaved: true } })
  }

  let content: ReactNode
  if (!open || !roles.data) {
    content =
      (groups.isError && !groups.data) || (roles.isError && !roles.data) ? (
        <Message alert>We couldn’t load your groups. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )
  } else {
    // permissions.md: admins and members add shifts; an employer is a viewer.
    const employers = open.filter((group) =>
      ['admin', 'member'].includes(roles.data.get(group.$id) ?? ''),
    )
    const first = employers.find((group) => group.$id === params.get('groupId')) ?? employers[0]
    if (!first) {
      content = (
        <Message>
          Add an employer first:{' '}
          <Link to="/groups/new-employer" className="underline">
            New employer
          </Link>
        </Message>
      )
    } else {
      const date = params.get('date')
      const fixedDate = date && isLocalDate(date) ? date : undefined
      // Today where the employer is, unless the link names the day.
      const todayFor = (group: Groups) => localToday(group.timezone, new Date())
      const values: ShiftValues = {
        groupId: first.$id,
        date: fixedDate ?? todayFor(first),
        description: 'Shift',
        timing: 'times',
        startTime: '',
        endTime: '',
        breakMinutes: '',
        hours: '',
        rate: defaultRate(first),
      }
      content = (
        <ShiftForm
          groups={employers}
          id={id}
          defaultValues={values}
          submitLabel="Add shift"
          rateFor={defaultRate}
          dateFor={fixedDate ? undefined : todayFor}
          onSave={async (body) => {
            try {
              const view = await save.mutateAsync({ body, isNew: true })
              navigate(`/shifts/${view.transaction.$id}`, { replace: true })
            } catch (error) {
              await openSaved(error)
            }
          }}
        />
      )
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New shift</h1>
      {content}
    </div>
  )
}

const STATUS: Record<Transactions['status'], string> = {
  scheduled: 'Scheduled: not confirmed yet.',
  due: 'Due.',
  running: 'The timer is running. Stop it on the Today screen, or void it here.',
  posted: 'Confirmed.',
  void: 'Voided.',
}

/** `/shifts/{id}`: change, confirm or void one shift. */
export function ShiftPage() {
  const id = useParams().shiftId ?? ''
  const transaction = useTransaction(id)
  const location = useLocation()
  const navigate = useNavigate()
  // Shown on this visit only: the history entry's state is cleared, so a reload doesn't repeat it.
  const [alreadySaved] = useState(
    () => (location.state as { alreadySaved?: boolean } | null)?.alreadySaved,
  )
  useEffect(() => {
    if (location.state) navigate('.', { replace: true, state: null })
  }, [location.state, navigate])
  // Confirm and Void go away once the shift changes: focus moves here, and the status line below
  // reads out the new status.
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <div className="flex flex-col gap-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        {transaction.data?.description ?? 'Shift'}
      </h1>
      {alreadySaved && (
        <Message>
          This shift was already added by an earlier try. Here it is as saved: change it here if you
          need to.
        </Message>
      )}
      {transaction.data ? (
        <ShiftDetails row={transaction.data} onAction={() => heading.current?.focus()} />
      ) : transaction.isError ? (
        <Message alert>We couldn’t load this shift. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

function ShiftDetails({ row, onAction }: { row: Transactions; onAction: () => void }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const group = useGroup(row.groupId)
  const member = useMyMember(row.groupId, personId)
  const save = useSaveShift()
  // Here, not in the panels: an optimistic confirm or void hides its panel, and after a
  // rollback the error and the typed reason must still be there.
  const confirm = useConfirmShift(row.$id)
  const voidShift = useVoidShift(row.$id)
  const [reason, setReason] = useState('')
  // Confirm posts the stored shift, so it waits until the form's changes are saved.
  const [dirty, setDirty] = useState(false)

  if (!group.data || member.data === undefined) {
    return (group.isError && !group.data) || (member.isError && member.data === undefined) ? (
      <Message alert>We couldn’t load this shift. Reload the page to try again.</Message>
    ) : (
      <Message>Loading…</Message>
    )
  }
  if (row.kind !== 'shift') return <Message>This isn’t a shift.</Message>

  const shift = storedShift(row.inputJson)
  const role = member.data?.role
  // permissions.md: the creator or an admin, never a viewer; the function checks again.
  const mayChange = role === 'admin' || (role === 'member' && row.createdBy === personId)
  const locked = row.statementId !== null
  const open = mayChange && !locked && !group.data.archivedAt
  const editable = shift && open && (row.status === 'scheduled' || row.status === 'posted')
  return (
    <>
      <Message>
        {STATUS[row.status]}
        {row.status === 'void' && row.voidReason ? ` Reason: ${row.voidReason}` : ''}
      </Message>
      {locked && <Message>It’s on a final invoice, so it can’t be changed.</Message>}
      {group.data.archivedAt && <Message>This group is archived.</Message>}
      {!mayChange && !locked && (
        <Message>Only an admin or the person who added it can change it.</Message>
      )}
      {open && row.status === 'scheduled' && (
        <ConfirmShift confirm={confirm} dirty={dirty} onConfirm={onAction} />
      )}
      {!editable && <ShiftSummary row={row} shift={shift} group={group.data} />}
      {editable && (
        <ShiftForm
          // A new status starts the form again from the stored shift, so it never shows pay
          // that wasn't recorded.
          key={row.status}
          groups={[group.data]}
          id={row.$id}
          defaultValues={toShiftValues(
            row,
            shift,
            centsToText(shift.rateCents, group.data.currency),
          )}
          submitLabel="Save"
          rateFor={defaultRate}
          storedMinutes={shift.minutes}
          onDirtyChange={setDirty}
          onSave={(body) => save.mutateAsync({ body, isNew: false })}
        />
      )}
      {/* A running timer can be voided too: one left on for more than a day can't be stopped. */}
      {open && row.status !== 'void' && (
        <VoidShift voidShift={voidShift} reason={reason} onReason={setReason} onVoid={onAction} />
      )}
    </>
  )
}

/** What a shift that can't be changed here records: its date, time worked and pay. */
function ShiftSummary({
  row,
  shift,
  group,
}: {
  row: Transactions
  shift: ReturnType<typeof storedShift>
  group: Groups
}) {
  const money = (cents: number) => formatMoney(cents, group.currency)
  // A running timer has no end, time worked or pay yet: only when it started.
  const running = row.status === 'running'
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Date</dt>
      <dd>{row.date}</dd>
      {running && row.startedAt && (
        <>
          <dt className="text-muted-foreground">Started</dt>
          <dd>
            {new Intl.DateTimeFormat(undefined, {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: group.timezone,
            }).format(Date.parse(row.startedAt))}
          </dd>
        </>
      )}
      {!running && shift?.startTime && shift.endTime && (
        <>
          <dt className="text-muted-foreground">Times</dt>
          <dd>
            {shift.startTime}–{shift.endTime}
          </dd>
        </>
      )}
      {!running && shift?.breakMinutes !== undefined && (
        <>
          <dt className="text-muted-foreground">Break</dt>
          <dd>{shift.breakMinutes} min</dd>
        </>
      )}
      {!running && shift && (
        <>
          <dt className="text-muted-foreground">Hours</dt>
          <dd>
            {Math.floor(shift.minutes / 60)} h {shift.minutes % 60} min at {money(shift.rateCents)}{' '}
            an hour
          </dd>
        </>
      )}
      {/* A void shift pays nothing. */}
      {!running && row.status !== 'void' && (
        <>
          <dt className="text-muted-foreground">Pay</dt>
          <dd>{money(row.totalCents)}</dd>
        </>
      )}
    </dl>
  )
}

function ConfirmShift({
  confirm,
  dirty,
  onConfirm,
}: {
  confirm: ReturnType<typeof useConfirmShift>
  dirty: boolean
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        onClick={() => {
          if (confirm.isPending || dirty) return
          onConfirm()
          confirm.mutate()
        }}
        // aria-disabled, not disabled: a disabled button loses focus.
        aria-disabled={confirm.isPending || dirty}
        aria-describedby={dirty ? 'confirm-hint' : undefined}
      >
        Confirm as worked
      </Button>
      {dirty && (
        <p id="confirm-hint" className="text-sm text-muted-foreground">
          Save your changes first.
        </p>
      )}
      {confirm.isError && <Message alert>{confirm.error.message}</Message>}
    </div>
  )
}

function VoidShift({
  voidShift,
  reason,
  onReason,
  onVoid,
}: {
  voidShift: ReturnType<typeof useVoidShift>
  reason: string
  onReason: (reason: string) => void
  onVoid: () => void
}) {
  const [error, setError] = useState<string>()
  return (
    <form
      noValidate
      className="flex flex-col gap-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (voidShift.isPending) return
        if (reason.trim() === '') {
          setError('Say why, for example “Didn’t go”.')
          return
        }
        setError(undefined)
        onVoid()
        voidShift.mutate({ reason: reason.trim() })
      }}
    >
      <TextField
        id="voidReason"
        label="Reason for voiding"
        value={reason}
        maxLength={200}
        onChange={(event) => onReason(event.target.value)}
        error={error ? { type: 'validate', message: error } : undefined}
      />
      {voidShift.isError && <Message alert>{voidShift.error.message}</Message>}
      <Button
        type="submit"
        variant="outline"
        className="self-start"
        aria-disabled={voidShift.isPending}
      >
        Void shift
      </Button>
    </form>
  )
}
