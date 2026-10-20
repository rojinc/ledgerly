import type { Groups } from '@ledgerly/core/generated/rows'
import { formatNet } from '@ledgerly/core/money/format'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import type { GroupDeleted } from './delete-group-page'
import { PendingGroups, TYPE_LABEL } from './pending-groups'
import { useGroupName, useSortedByName } from './use-group-name'
import { useBalances, useGroups } from './use-groups'

/**
 * A group's own page: an employer's settings, the person's page for lend & borrow (#34), or a
 * house's page. A personal group has none.
 */
export function groupPath(group: Pick<Groups, '$id' | 'type'>): string | null {
  return group.type === 'employer'
    ? `/groups/${group.$id}/settings`
    : group.type === 'pair'
      ? `/people/${group.$id}`
      : group.type === 'house'
        ? `/groups/${group.$id}`
        : null
}

export function GroupsPage() {
  const groups = useGroups()
  const heading = useRef<HTMLHeadingElement>(null)
  const [joined, setJoined] = useState('')
  // Sent here by the delete page (#429), whose button is gone: focus and the news start here.
  const deleted = useLocation().state as GroupDeleted | null
  useEffect(() => {
    if (deleted?.name) heading.current?.focus()
  }, [deleted])
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          Groups
        </h1>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/groups/new-house"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            New house
          </Link>
          <Link
            to="/groups/new-employer"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            New employer
          </Link>
        </div>
      </div>
      {/* Mounted from the start, so the announcement is read out when it changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {joined
          ? `Joined ${joined}.`
          : deleted?.name &&
            `Deleted ${deleted.name}.${deleted.finished ? '' : ' The rest of it is removed within the hour.'}`}
      </p>
      <PendingGroups
        onJoined={(name) => {
          setJoined(name)
          // The joined row and its focused button go away: keep focus on the page.
          heading.current?.focus()
        }}
      />
      {groups.data ? (
        <>
          <GroupList groups={groups.data.filter((group) => !group.archivedAt)} />
          {groups.data.some((group) => group.archivedAt) && (
            <section aria-labelledby="archived-groups" className="flex flex-col gap-2">
              <h2 id="archived-groups" className="font-medium">
                Archived
              </h2>
              <GroupList groups={groups.data.filter((group) => group.archivedAt)} />
            </section>
          )}
        </>
      ) : groups.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-destructive">
            We couldn’t load your groups.
          </p>
          <Button variant="outline" onClick={() => groups.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      )}
    </div>
  )
}

function GroupList({ groups }: { groups: Groups[] }) {
  const sorted = useSortedByName(groups)
  if (groups.length === 0) return null
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {sorted.map((group) => (
        <GroupRow key={group.$id} group={group} />
      ))}
    </ul>
  )
}

function GroupRow({ group }: { group: Groups }) {
  const name = useGroupName(group)
  const to = groupPath(group)
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {to ? (
            <Link to={to} className="underline-offset-4 hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {TYPE_LABEL[group.type]}
          {group.archivedAt ? ' · Archived' : ''}
        </p>
      </div>
      <Balance group={group} />
    </li>
  )
}

/** The user's balance in the group, in plain words. */
function Balance({ group }: { group: Groups }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const balances = useBalances(group.$id)
  if (!balances.data) {
    return balances.isError ? (
      <span className="text-sm text-muted-foreground" title="Balance not available yet">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Balance not available yet</span>
      </span>
    ) : (
      <span className="text-sm text-muted-foreground">…</span>
    )
  }
  const net = balances.data.people.find((person) => person.personId === personId)?.netCents ?? 0
  const amount = formatNet(Math.abs(net), group.currency)
  const text = net > 0 ? `Owed ${amount}` : net < 0 ? `You owe ${amount}` : 'Settled'
  return <span className="shrink-0 text-sm font-medium">{text}</span>
}
