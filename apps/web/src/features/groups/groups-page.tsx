import type { Groups } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import { Link } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useBalances, useGroups } from './use-groups'

const TYPE_LABEL: Record<Groups['type'], string> = {
  personal: 'Personal',
  employer: 'Employer',
  house: 'House',
  pair: 'Shared with one person',
}

export function GroupsPage() {
  const groups = useGroups()
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Groups</h1>
        <Link
          to="/groups/new-employer"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          New employer
        </Link>
      </div>
      {groups.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
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
        <ul className="divide-y divide-border rounded-md border border-border">
          {groups.data.map((group) => (
            <GroupRow key={group.$id} group={group} />
          ))}
        </ul>
      )}
    </div>
  )
}

function GroupRow({ group }: { group: Groups }) {
  const settings = group.type === 'employer' ? `/groups/${group.$id}/settings` : null
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {settings ? (
            <Link to={settings} className="underline-offset-4 hover:underline">
              {group.name}
            </Link>
          ) : (
            group.name
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
  if (balances.isPending) return <span className="text-sm text-muted-foreground">…</span>
  if (balances.isError) {
    return (
      <span className="text-sm text-muted-foreground" title="Balance not available yet">
        —
      </span>
    )
  }
  const net = balances.data.people.find((person) => person.personId === personId)?.netCents ?? 0
  const amount = formatMoney(Math.abs(net), group.currency)
  const text = net > 0 ? `Owed ${amount}` : net < 0 ? `You owe ${amount}` : 'Settled'
  return <span className="shrink-0 text-sm font-medium">{text}</span>
}
