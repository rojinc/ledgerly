import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useNavigate, useParams } from 'react-router'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroup, useMyMember } from '../groups/use-groups'
import { DivideView } from './divide-view'
import { readSnapshot } from './invoice-sections'
import { formatDate, InvoiceView } from './invoice-view'
import { STATUS_LABEL } from './statements-page'
import {
  downloadPdf,
  type FinalizeResult,
  useDiscardStatement,
  useFinalizeStatement,
  useRefreshStatement,
  useSendStatement,
  useStatement,
  useStatements,
  useVoidStatement,
} from './use-statements'

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={`break-words ${alert ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {children}
    </p>
  )
}

/**
 * Shows a panel in place of the button that opened it, with focus on the panel's heading, and
 * puts focus back on the button when it closes: the focused element unmounts either way.
 */
function useSwap() {
  const [opened, setOpened] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  return {
    opened,
    trigger,
    heading,
    open: () => {
      flushSync(() => setOpened(true))
      heading.current?.focus()
    },
    close: () => {
      flushSync(() => setOpened(false))
      trigger.current?.focus()
    },
  }
}

/** A statement's dates in words: `1 Oct 2026 – 31 Oct 2026`. */
export function periodText(statement: Pick<Statements, 'periodStart' | 'periodEnd'>): string {
  return `${formatDate(statement.periodStart)} – ${formatDate(statement.periodEnd)}`
}

/** An invoice by its number; a divide, which never has one, by its period (#166). */
function title(statement: Statements): string {
  if (statement.type === 'divide') return `Divide for ${periodText(statement)}`
  return statement.displayNumber ?? 'Draft invoice'
}

/**
 * `/groups/{groupId}/statements/{id}`: review a draft, finalize and send it, or the PDF (#32);
 * an invoice or a house's divide (#166).
 */
export function StatementPage() {
  const { groupId = '', statementId = '' } = useParams()
  const statement = useStatement(statementId)
  // Focus lands here when an action ends and its panel goes away.
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <div className="flex flex-col gap-6">
      <Link to={`/groups/${groupId}/statements`} className="text-sm underline underline-offset-4">
        {statement.data?.type === 'divide' ? 'All statements' : 'All invoices'}
      </Link>
      <h1
        ref={heading}
        tabIndex={-1}
        className="min-w-0 text-2xl font-semibold break-words outline-none"
      >
        {statement.data ? title(statement.data) : 'Statement'}
      </h1>
      {statement.data ? (
        <Details row={statement.data} onDone={() => heading.current?.focus()} />
      ) : statement.isError ? (
        <Message alert>We couldn’t load this statement. Reload the page to try again.</Message>
      ) : (
        <Message>Loading…</Message>
      )}
    </div>
  )
}

function Details({ row, onDone }: { row: Statements; onDone: () => void }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const group = useGroup(row.groupId)
  const member = useMyMember(row.groupId, personId)
  const all = useStatements(row.groupId)
  const refresh = useRefreshStatement(row.$id)
  const [done, setDone] = useState('')

  // statements.md#1: a draft is worked out again each time it's opened, once: React runs effects
  // twice in development, and two refreshes at once clash (CONFLICT). Not in an archived group,
  // whose statements can't change.
  const isDraft = row.status === 'draft'
  const canRefresh = isDraft && group.data !== undefined && !group.data.archivedAt
  const { mutate: refreshDraft } = refresh
  const refreshed = useRef('')
  useEffect(() => {
    if (!canRefresh || refreshed.current === row.$id) return
    refreshed.current = row.$id
    refreshDraft()
  }, [canRefresh, refreshDraft, row.$id])

  const snapshot = readSnapshot(row.snapshotJson)
  const divide = row.type === 'divide'
  const isAdmin = member.data?.role === 'admin'
  const open = isAdmin && group.data !== undefined && !group.data.archivedAt
  const unfinished = row.status === 'draft' || row.status === 'finalizing'
  // statements.md core rule 5: only the oldest unfinished statement can be finalized.
  const earlier = all.data
    ?.filter(
      (statement) =>
        (statement.status === 'draft' || statement.status === 'finalizing') &&
        statement.periodEnd < row.periodEnd,
    )
    .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1))[0]
  // Only the latest final statement can be voided, so openings never break (statements.md#4).
  const latestFinal = all.data
    ?.filter((statement) => statement.status === 'final')
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0]
  // statements.md#5: discarding the group's latest draft rolls its period into the next one.
  const latest = all.data?.every(
    (statement) => statement.$id === row.$id || statement.periodEnd < row.periodEnd,
  )
  const finish = (message: string) => {
    setDone(message)
    onDone()
  }

  return (
    <>
      <p className="text-muted-foreground">
        {STATUS_LABEL[row.status]}
        {row.sentAt && group.data ? ` · Sent ${sentOn(row.sentAt, group.data)}` : ''}
      </p>
      {/* Mounted from the start, so a change is read out. */}
      <p role="status" className="text-sm break-words empty:hidden">
        {done}
      </p>
      {isDraft && refresh.isPending && <Message>Updating from your latest entries…</Message>}
      {isDraft && refresh.isError && (
        <Message alert>
          We couldn’t update this draft, so it may be out of date. {refresh.error.message}
        </Message>
      )}
      {open && row.status === 'finalizing' && (
        <Message>
          Finalizing didn’t finish. Finalize again to complete it; the steps already done are kept.
        </Message>
      )}
      {open && unfinished && earlier && (
        <Message>
          Finalize the earlier {divide ? 'statement' : 'invoice'} first:{' '}
          <Link
            to={`/groups/${row.groupId}/statements/${earlier.$id}`}
            className="underline underline-offset-4"
          >
            {formatDate(earlier.periodStart)} – {formatDate(earlier.periodEnd)}
          </Link>
        </Message>
      )}
      {open && unfinished && all.data && !earlier && (
        <Finalize statement={row} refreshing={refresh.isPending} onFinish={finish} />
      )}
      {/* An invoice draft with a number can't be discarded (statements.md#5): it's refused. */}
      {open && isDraft && row.number === null && all.data && latest !== undefined && (
        <Discard statement={row} latest={latest} busy={refresh.isPending} />
      )}
      {(row.status === 'final' || row.status === 'void') && group.data && (
        <FinalActions
          statement={row}
          group={group.data}
          admin={open && row.status === 'final'}
          latest={latestFinal?.$id === row.$id}
          onFinish={finish}
        />
      )}
      {snapshot ? (
        divide ? (
          <DivideView statement={row} snapshot={snapshot} />
        ) : (
          <InvoiceView statement={row} snapshot={snapshot} />
        )
      ) : (
        <Message alert>This statement can’t be shown. Reload the page to try again.</Message>
      )}
    </>
  )
}

/** The day it was sent, in the group's time zone. */
function sentOn(sentAt: string, group: Groups): string {
  return formatDate(localToday(group.timezone, new Date(sentAt)))
}

/**
 * A divide's refused finalize in its own words (#166); an invoice keeps the server's. An async
 * execution usually keeps no body, so its status code stands in for the code: a 409 back at
 * `draft` is most likely an earlier statement or a clash (it says to try again), and a 500 back
 * at `draft` is finalize step 5's failed check (statements.md#2).
 */
function divideRefused({ statement, code, status }: FinalizeResult): string | undefined {
  if (statement.status !== 'draft') return undefined
  if (code === 'CONFLICT' || (!code && status === 409)) {
    return 'Finalize the earlier statement first. If there isn’t one, try again.'
  }
  if (code === 'INVARIANT_VIOLATION' || (!code && status === 500)) {
    return 'It didn’t add up, so it’s still a draft.'
  }
  return undefined
}

function Finalize({
  statement,
  refreshing,
  onFinish,
}: {
  statement: Statements
  refreshing: boolean
  onFinish: (message: string) => void
}) {
  const finalize = useFinalizeStatement(statement)
  const swap = useSwap()
  const [error, setError] = useState('')
  const divide = statement.type === 'divide'
  const recipients = readSnapshot(statement.snapshotJson)?.recipient?.emails ?? []
  // Not while the draft is still being refreshed: what's reviewed is what's finalized.
  const busy = finalize.isPending || refreshing
  const run = (send: boolean) => {
    if (busy) return
    setError('')
    finalize.mutate(send, {
      onSuccess: (result) => {
        const { statement: row, error: failed } = result
        if (row.status !== 'final') {
          setError((divide && divideRefused(result)) || failed || 'It wasn’t finalized. Try again.')
          return
        }
        const notSent = send && !row.sentAt
        if (divide) {
          onFinish(
            notSent
              ? `Finalized, but it wasn’t emailed${failed ? `: ${failed}` : '.'} Use Email everyone to try again.`
              : `Finalized${send ? ' and emailed to everyone' : ''}.${failed ? ` ${failed}` : ''}`,
          )
          return
        }
        onFinish(
          notSent
            ? `Finalized as ${row.displayNumber}, but it wasn’t sent${failed ? `: ${failed}` : '.'} Use Send to try again.`
            : `Finalized as ${row.displayNumber}${send ? ' and sent' : ''}.${failed ? ` ${failed}` : ''}`,
        )
      },
      onError: (thrown) => setError(thrown.message),
    })
  }

  if (!swap.opened) {
    return (
      <Button ref={swap.trigger} className="self-start" onClick={swap.open}>
        Finalize…
      </Button>
    )
  }
  if (divide) {
    return (
      <section
        aria-labelledby="finalize-heading"
        className="flex flex-col gap-3 rounded-md border border-border p-4"
      >
        <h2
          id="finalize-heading"
          ref={swap.heading}
          tabIndex={-1}
          className="font-medium outline-none"
        >
          Finalize this divide?
        </h2>
        <p className="text-sm">
          This locks every transaction on it and makes the PDF. A final divide never changes: a
          mistake found later is fixed on the next one.
        </p>
        <p className="text-sm">
          Emailing sends each housemate their own balance, with the PDF attached.
        </p>
        {finalize.isPending && <Message>Finalizing… This can take up to a minute.</Message>}
        {error && <Message alert>{error}</Message>}
        <div className="flex flex-wrap gap-3">
          <Button aria-disabled={busy} onClick={() => run(true)}>
            Finalize and email everyone
          </Button>
          <Button variant="outline" aria-disabled={busy} onClick={() => run(false)}>
            Finalize only
          </Button>
          <Button
            variant="ghost"
            aria-disabled={finalize.isPending}
            onClick={() => !finalize.isPending && swap.close()}
          >
            Cancel
          </Button>
        </div>
      </section>
    )
  }
  return (
    <section
      aria-labelledby="finalize-heading"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <h2
        id="finalize-heading"
        ref={swap.heading}
        tabIndex={-1}
        className="font-medium outline-none"
      >
        Finalize this invoice?
      </h2>
      <p className="text-sm">
        This locks every transaction on it, gives it its number and makes the PDF. Sent invoices
        never change: a mistake found later is fixed with an adjustment on the next one.
      </p>
      {recipients.length > 0 ? (
        <p className="text-sm break-words">Sending emails it to {recipients.join(', ')}.</p>
      ) : (
        <p className="text-sm">
          The group has no billing email, so it can be finalized but not sent.
        </p>
      )}
      {finalize.isPending && <Message>Finalizing… This can take up to a minute.</Message>}
      {error && <Message alert>{error}</Message>}
      <div className="flex flex-wrap gap-3">
        {/* aria-disabled, not disabled: a disabled button loses focus. */}
        {recipients.length > 0 && (
          <Button aria-disabled={busy} onClick={() => run(true)}>
            Finalize and send
          </Button>
        )}
        <Button
          variant={recipients.length > 0 ? 'outline' : 'default'}
          aria-disabled={busy}
          onClick={() => run(false)}
        >
          Finalize without sending
        </Button>
        <Button
          variant="ghost"
          aria-disabled={finalize.isPending}
          onClick={() => !finalize.isPending && swap.close()}
        >
          Cancel
        </Button>
      </div>
    </section>
  )
}

function FinalActions({
  statement,
  group,
  admin,
  latest,
  onFinish,
}: {
  statement: Statements
  group: Groups
  admin: boolean
  latest: boolean
  onFinish: (message: string) => void
}) {
  const send = useSendStatement(statement)
  const divide = statement.type === 'divide'
  const sendLabel = divide
    ? statement.sentAt
      ? 'Email everyone again'
      : 'Email everyone'
    : statement.sentAt
      ? 'Send again'
      : 'Send'
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const swap = useSwap()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {statement.pdfFileId && (
          <Button
            variant="outline"
            aria-disabled={downloading}
            onClick={() => {
              if (downloading) return
              setDownloading(true)
              setDownloadError('')
              downloadPdf(statement)
                .catch(() => setDownloadError('We couldn’t download the PDF. Try again.'))
                .finally(() => setDownloading(false))
            }}
          >
            Download PDF
          </Button>
        )}
        {admin && (
          <Button
            variant="outline"
            aria-disabled={send.isPending}
            onClick={() => !send.isPending && send.mutate()}
          >
            {send.isPending ? 'Sending…' : sendLabel}
          </Button>
        )}
        {admin && latest && !swap.opened && (
          <Button ref={swap.trigger} variant="outline" onClick={swap.open}>
            Void…
          </Button>
        )}
      </div>
      {downloadError && <Message alert>{downloadError}</Message>}
      {send.isError && <Message alert>{send.error.message}</Message>}
      {send.isSuccess && (
        <Message>{divide ? `Sent ${sentOn(send.data.sentAt, group)}.` : 'Sent.'}</Message>
      )}
      {/* Gone once it's void, with the Void… button it replaced. */}
      {admin && latest && swap.opened && (
        <VoidStatement
          statement={statement}
          heading={swap.heading}
          onCancel={swap.close}
          onFinish={onFinish}
        />
      )}
    </div>
  )
}

function VoidStatement({
  statement,
  heading,
  onCancel,
  onFinish,
}: {
  statement: Statements
  heading: RefObject<HTMLHeadingElement | null>
  onCancel: () => void
  onFinish: (message: string) => void
}) {
  const voidStatement = useVoidStatement(statement.$id)
  const divide = statement.type === 'divide'
  const name = statement.displayNumber ?? 'this divide'
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  return (
    <form
      noValidate
      aria-labelledby="void-heading"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (voidStatement.isPending) return
        if (reason.trim() === '') {
          setError('Required')
          return
        }
        setError('')
        voidStatement.mutate(
          { reason: reason.trim() },
          { onSuccess: () => onFinish(divide ? 'This divide is void.' : `${name} is void.`) },
        )
      }}
    >
      <h2 id="void-heading" ref={heading} tabIndex={-1} className="font-medium outline-none">
        Void {name}?
      </h2>
      <p className="text-sm">
        {divide
          ? 'Its transactions unlock, so they go on the next divide. The PDF stays for your records.'
          : 'Its transactions unlock, so they go on the next invoice. It keeps its number, and the PDF stays for your records.'}
      </p>
      <TextField
        id="voidReason"
        label="Reason"
        maxLength={200}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={error ? { type: 'required', message: error } : undefined}
      />
      {voidStatement.isError && <Message alert>{voidStatement.error.message}</Message>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" aria-disabled={voidStatement.isPending}>
          {voidStatement.isPending ? 'Voiding…' : divide ? 'Void divide' : 'Void invoice'}
        </Button>
        <Button
          variant="ghost"
          aria-disabled={voidStatement.isPending}
          onClick={() => !voidStatement.isPending && onCancel()}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * Deletes a draft, invoice or divide, after confirming (statements.md#5), then goes back to the
 * list. On the group's latest draft, its period rolls into the next statement.
 */
function Discard({
  statement,
  latest,
  busy,
}: {
  statement: Statements
  latest: boolean
  busy: boolean
}) {
  const discard = useDiscardStatement(statement)
  const navigate = useNavigate()
  const swap = useSwap()
  const period = periodText(statement)
  if (!swap.opened) {
    return (
      <Button ref={swap.trigger} variant="outline" className="self-start" onClick={swap.open}>
        Discard draft…
      </Button>
    )
  }
  return (
    <section
      aria-labelledby="discard-heading"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <h2
        id="discard-heading"
        ref={swap.heading}
        tabIndex={-1}
        className="font-medium outline-none"
      >
        Discard the draft for {period}?
      </h2>
      <p className="text-sm">
        It’s deleted. Its transactions don’t change.
        {latest && ` This period, ${period}, will be included in the next statement.`}
      </p>
      {discard.isError && <Message alert>{discard.error.message}</Message>}
      <div className="flex flex-wrap gap-3">
        <Button
          // Not while the draft is being refreshed: the refresh would find it gone.
          aria-disabled={discard.isPending || busy}
          onClick={() => {
            if (discard.isPending || busy) return
            discard.mutate(undefined, {
              onSuccess: () =>
                navigate(`/groups/${statement.groupId}/statements`, {
                  replace: true,
                  state: { discarded: period },
                }),
            })
          }}
        >
          {discard.isPending ? 'Discarding…' : 'Discard draft'}
        </Button>
        <Button
          variant="ghost"
          aria-disabled={discard.isPending}
          onClick={() => !discard.isPending && swap.close()}
        >
          Cancel
        </Button>
      </div>
    </section>
  )
}
