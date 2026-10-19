import type { Groups } from '@ledgerly/core/generated/rows'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '../../ui/button'
import { SelectField } from '../../ui/field'
import { GroupName, useSortedByName } from '../groups/use-group-name'
import { useGroups } from '../groups/use-groups'
import { useMembers } from '../transactions/use-transactions'
import { useActivity } from './use-activity'

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
 * `/activity?groupId=`: who added, changed or voided what in one of the user's groups, newest
 * first (#47). Every role that can read the group sees it, in archived groups too.
 */
export function ActivityPage() {
  const groups = useGroups()
  const sorted = useSortedByName(groups.data ?? [])
  const [params, setParams] = useSearchParams()
  const groupId = params.get('groupId') || null
  // Without a choice, the first group. A link to a group that isn't the user's finds none.
  // The first can change once, when pair groups' members load and they sort by the name shown.
  const group = groupId === null ? sorted[0] : sorted.find((g) => g.$id === groupId)

  let content: ReactNode
  if (!groups.data) {
    content = groups.isError ? (
      <div className="flex flex-col items-start gap-3">
        <Message alert>We couldn’t load your groups.</Message>
        <Button variant="outline" onClick={() => groups.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <Message>Loading…</Message>
    )
  } else if (sorted.length === 0) {
    content = <Message>You aren’t in any group yet.</Message>
  } else {
    content = (
      <>
        <SelectField
          id="activityGroup"
          label="Group"
          value={group?.$id ?? ''}
          onChange={(event) => setParams({ groupId: event.target.value }, { replace: true })}
        >
          {!group && (
            <option value="" disabled>
              Choose a group
            </option>
          )}
          {sorted.map((g) => (
            <option key={g.$id} value={g.$id}>
              <GroupName group={g} />
              {g.archivedAt ? ' (archived)' : ''}
            </option>
          ))}
        </SelectField>
        {group ? (
          <Feed key={group.$id} group={group} />
        ) : (
          <Message alert>We couldn’t find that group.</Message>
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Activity</h1>
      {content}
    </div>
  )
}

function Feed({ group }: { group: Groups }) {
  const activity = useActivity(group.$id)
  // Names only from this group's member rows: never persons, identities or the Teams API.
  const members = useMembers(group.$id)
  if (!activity.data || !members.data) {
    return activity.isError || members.isError ? (
      <div className="flex flex-col items-start gap-3">
        <Message alert>We couldn’t load the activity.</Message>
        <Button
          variant="outline"
          onClick={() => {
            void activity.refetch()
            void members.refetch()
          }}
        >
          Try again
        </Button>
      </div>
    ) : (
      <Message>Loading…</Message>
    )
  }
  const names = new Map(members.data.map((member) => [member.personId, member.displayName]))
  // The group's time zone, not the device's: it's when it happened where the group is.
  const formatAt = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: group.timezone,
  })
  const entries = activity.data.pages.flat()
  if (entries.length === 0) return <Message>Nothing has happened in this group yet.</Message>
  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border rounded-md border border-border">
        {entries.map((entry) => (
          <li key={entry.$id} className="flex flex-col gap-1 px-3 py-2">
            <p className="break-words">{entry.summary}</p>
            <p className="text-sm break-words text-muted-foreground">
              {/* No actor: a system job. No member row any more: removed from the group. */}
              {entry.actorPersonId
                ? (names.get(entry.actorPersonId) ?? 'A former member')
                : 'Automatic'}{' '}
              · <time dateTime={entry.at}>{formatAt.format(Date.parse(entry.at))}</time>
            </p>
            {entry.transactionId && (
              <Link
                to={`/transactions/${entry.transactionId}`}
                className="self-start text-sm underline underline-offset-4"
              >
                View transaction
              </Link>
            )}
          </li>
        ))}
      </ul>
      {activity.isFetchNextPageError && (
        <Message alert>We couldn’t load older activity. Try again.</Message>
      )}
      {activity.hasNextPage && (
        // aria-disabled, not disabled: a disabled button loses focus.
        <Button
          variant="outline"
          className="self-start"
          aria-disabled={activity.isFetchingNextPage}
          onClick={() => {
            if (!activity.isFetchingNextPage) void activity.fetchNextPage()
          }}
        >
          {activity.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </div>
  )
}
