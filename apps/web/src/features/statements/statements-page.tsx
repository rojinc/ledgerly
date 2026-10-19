import type { Statements } from '@ledgerly/core/generated/rows'
import { formatNet } from '@ledgerly/core/money/format'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { Button } from '../../ui/button'
import { useGroup } from '../groups/use-groups'
import { readSnapshot } from './invoice-sections'
import { formatDate } from './invoice-view'
import { useStatements } from './use-statements'

export const STATUS_LABEL: Record<Statements['status'], string> = {
  draft: 'Draft',
  finalizing: 'Finalizing',
  final: 'Final',
  void: 'Void',
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

/**
 * `/groups/{groupId}/statements`: a group's invoices (#32), or a house's divides (#166), latest
 * period first.
 */
export function StatementsPage() {
  const groupId = useParams().groupId ?? ''
  const group = useGroup(groupId)
  const statements = useStatements(groupId)
  const house = group.data?.type === 'house'
  // A discard comes back here (#166): say so in a status region that was already there, so it's
  // read out, and focus the heading. The state is cleared, so a reload doesn't say it again.
  const location = useLocation()
  const navigate = useNavigate()
  const heading = useRef<HTMLHeadingElement>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    const discarded = (location.state as { discarded?: string } | null)?.discarded
    if (!discarded) return
    setNote(`The draft for ${discarded} was discarded.`)
    heading.current?.focus()
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  let content: ReactNode
  if (!statements.data || !group.data) {
    content =
      (statements.isError && !statements.data) || (group.isError && !group.data) ? (
        <div className="flex flex-col items-start gap-3">
          <Message alert>We couldn’t load the {house ? 'statements' : 'invoices'}.</Message>
          <Button
            variant="outline"
            onClick={() => {
              void statements.refetch()
              void group.refetch()
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <Message>Loading…</Message>
      )
  } else if (statements.data.length === 0) {
    content = (
      <p className="text-muted-foreground">
        {house
          ? 'No statements yet. The first divide is drafted when this house’s period ends.'
          : 'No invoices yet. The first draft is made when this group’s period ends.'}
      </p>
    )
  } else {
    const currency = group.data.currency
    content = (
      <ul className="divide-y divide-border rounded-md border border-border">
        {statements.data.map((statement) => {
          const balance = readSnapshot(statement.snapshotJson)?.invoice?.balanceDueCents
          return (
            <li key={statement.$id}>
              <Link
                to={`/groups/${groupId}/statements/${statement.$id}`}
                className="flex flex-wrap items-center justify-between gap-x-3 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="min-w-0">
                  <span
                    className={`block font-medium ${statement.status === 'void' ? 'line-through' : ''}`}
                  >
                    {statement.type === 'divide'
                      ? statement.status === 'draft' || statement.status === 'finalizing'
                        ? 'Draft divide'
                        : 'Divide'
                      : (statement.displayNumber ?? 'Draft invoice')}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {formatDate(statement.periodStart)} – {formatDate(statement.periodEnd)} ·{' '}
                    {STATUS_LABEL[statement.status]}
                    {statement.sentAt ? ' · Sent' : ''}
                  </span>
                </span>
                {balance !== undefined && (
                  <span className="text-sm tabular-nums">{formatNet(balance, currency)}</span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="min-w-0 text-2xl font-semibold break-words outline-none"
      >
        {house ? 'Statements' : 'Invoices'}
        {group.data ? ` for ${group.data.name}` : ''}
      </h1>
      <p role="status" className="text-muted-foreground empty:hidden">
        {note}
      </p>
      {content}
    </div>
  )
}
