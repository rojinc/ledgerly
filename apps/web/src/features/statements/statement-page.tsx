import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useSwap } from '../../lib/use-swap'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroup, useMyMember } from '../groups/use-groups'
import { readSnapshot } from './invoice-sections'
import { formatDate, InvoiceView } from './invoice-view'
import { STATUS_LABEL } from './statements-page'
import {
  downloadPdf,
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

/** `/groups/{groupId}/statements/{id}`: review a draft, finalize and send it, or the PDF (#32). */
export function StatementPage() {
  const { groupId = '', statementId = '' } = useParams()
  const statement = useStatement(statementId)
  // Focus lands here when an action ends and its panel goes away.
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <div className="flex flex-col gap-6">
      <Link to={`/groups/${groupId}/statements`} className="text-sm underline underline-offset-4">
        All invoices
      </Link>
      <h1
        ref={heading}
        tabIndex={-1}
        className="min-w-0 text-2xl font-semibold break-words outline-none"
      >
        {statement.data ? (statement.data.displayNumber ?? 'Draft invoice') : 'Invoice'}
      </h1>
      {statement.data ? (
        <Details row={statement.data} onDone={() => heading.current?.focus()} />
      ) : statement.isError ? (
        <Message alert>We couldn’t load this invoice. Reload the page to try again.</Message>
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
          Finalize the earlier invoice first:{' '}
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
      {(row.status === 'final' || row.status === 'void') && (
        <FinalActions
          statement={row}
          admin={open && row.status === 'final'}
          latest={latestFinal?.$id === row.$id}
          onFinish={finish}
        />
      )}
      {snapshot ? (
        <InvoiceView statement={row} snapshot={snapshot} />
      ) : (
        <Message alert>This invoice can’t be shown. Reload the page to try again.</Message>
      )}
    </>
  )
}

/** The day it was sent, in the group's time zone. */
function sentOn(sentAt: string, group: Groups): string {
  return formatDate(localToday(group.timezone, new Date(sentAt)))
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
  const recipients = readSnapshot(statement.snapshotJson)?.recipient?.emails ?? []
  // Not while the draft is still being refreshed: what's reviewed is what's finalized.
  const busy = finalize.isPending || refreshing
  const run = (send: boolean) => {
    if (busy) return
    setError('')
    finalize.mutate(send, {
      onSuccess: ({ statement: row, error: failed }) => {
        if (row.status !== 'final') {
          setError(failed ?? 'It wasn’t finalized. Try again.')
          return
        }
        const notSent = send && !row.sentAt
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
  admin,
  latest,
  onFinish,
}: {
  statement: Statements
  admin: boolean
  latest: boolean
  onFinish: (message: string) => void
}) {
  const send = useSendStatement(statement)
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
            {send.isPending ? 'Sending…' : statement.sentAt ? 'Send again' : 'Send'}
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
      {send.isSuccess && <Message>Sent.</Message>}
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
          { onSuccess: () => onFinish(`${statement.displayNumber} is void.`) },
        )
      }}
    >
      <h2 id="void-heading" ref={heading} tabIndex={-1} className="font-medium outline-none">
        Void {statement.displayNumber}?
      </h2>
      <p className="text-sm">
        Its transactions unlock, so they go on the next invoice. It keeps its number, and the PDF
        stays for your records.
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
          {voidStatement.isPending ? 'Voiding…' : 'Void invoice'}
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
