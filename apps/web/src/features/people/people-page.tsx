import type { Groups } from '@ledgerly/core/generated/rows'
import { Link } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useBalances, useGroups } from '../groups/use-groups'
import { useMembers } from '../transactions/use-transactions'
import { balanceText } from './pair-values'

/** `/people`: everyone the user lends to or borrows from, with the balance (#34). */
export function PeoplePage() {
  const groups = useGroups()
  const pairs = groups.data?.filter((group) => group.type === 'pair')
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Lend & borrow</h1>
        <Link
          to="/people/new"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          New lend & borrow
        </Link>
      </div>
      {pairs ? (
        pairs.length === 0 ? (
          <p className="text-muted-foreground">
            No one yet. Record money you lend or borrow with “New lend & borrow”.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {pairs.map((group) => (
              <PairRow key={group.$id} group={group} />
            ))}
          </ul>
        )
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

function PairRow({ group }: { group: Groups }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const balances = useBalances(group.$id)
  // The other person's name: the group's name is what its creator called them, which is the
  // viewer's own name when the viewer is that person.
  const members = useMembers(group.$id)
  // Until the viewer's person is known, either member could be the other one.
  const them = personId ? members.data?.find((member) => member.personId !== personId) : undefined
  const name = them?.displayName ?? group.name
  const net = personId
    ? (balances.data?.people.find((person) => person.personId === personId)?.netCents ?? 0)
    : undefined
  return (
    <li>
      <Link
        to={`/people/${group.$id}`}
        className="flex flex-wrap items-center justify-between gap-x-3 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="min-w-0 font-medium break-words">
          {name}
          {group.archivedAt ? <span className="text-muted-foreground"> · Archived</span> : null}
        </span>
        <span className="text-sm">
          {balances.data && net !== undefined ? (
            balanceText(net, name, group.currency)
          ) : balances.isError ? (
            <span className="text-muted-foreground">Balance not available yet</span>
          ) : (
            <span className="text-muted-foreground">
              <span aria-hidden="true">…</span>
              <span className="sr-only">Loading balance</span>
            </span>
          )}
        </span>
      </Link>
    </li>
  )
}
