import type { Groups } from '@ledgerly/core/generated/rows'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../../ui/button'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { PendingGroups } from '../groups/pending-groups'
import { GroupName, useSortedByName } from '../groups/use-group-name'
import { useProfile } from '../profile/use-profile'
import { isHidden, storeHidden, useHasEntry } from './use-onboarding'

const ROW =
  'flex flex-col gap-0.5 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

const CHOICES = [
  {
    to: '/groups/new-employer',
    title: 'Hours I work for someone',
    description: 'Log your shifts and send invoices to an employer.',
  },
  {
    to: '/people/new',
    title: 'Money I lent or borrowed',
    description: 'Keep track of what you and one other person owe each other.',
  },
  {
    to: '/bills/new',
    title: 'My bills',
    description: 'Rent, phone and other bills, with when each one is due.',
  },
]

/**
 * Home's guide for a new user (#52): what to track first, then their first entry. It's worked out
 * from the joined groups and one transactions read, and it goes for good once there's an entry.
 * While any of that loads or fails, it shows nothing, so the dashboard is as it always was.
 */
export function GettingStarted({
  groups,
  focusHeading,
}: {
  groups: Groups[]
  focusHeading: () => void
}) {
  const userId = useCurrentUser().data?.$id ?? ''
  const bootstrap = useBootstrap(userId)
  const [hiddenNow, setHiddenNow] = useState(false)
  const [joined, setJoined] = useState('')
  const hidden = hiddenNow || isHidden(userId)
  const groupIds = groups.map((group) => group.$id)
  const entry = useHasEntry(groupIds, !hidden)

  const hasEntry = groupIds.length === 0 ? false : entry.data
  const personal = bootstrap.data?.personalGroupId
  let step: 1 | 2 | undefined
  if (personal !== undefined && hasEntry === false) {
    step = groups.every((group) => group.$id === personal) ? 1 : 2
  }
  const personId = bootstrap.data?.personId ?? ''
  // By the name shown, so a pair sorts under its other member (#147 O11).
  const links = useSortedByName(groups).flatMap((group) => {
    const link = firstEntryLink(group, personId)
    return link ? [{ group, ...link }] : []
  })

  function hide() {
    storeHidden(userId)
    setHiddenNow(true)
    // The section and its focused button go away: keep focus on the page.
    focusHeading()
  }

  return (
    <>
      {/* Mounted from the start, so the announcement is read out when it changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {joined && `Joined ${joined}.`}
      </p>
      {!hidden && step === 1 && (
        <>
          <PendingGroups
            onJoined={(name) => {
              setJoined(name)
              // The joined row and its focused button go away: keep focus on the page.
              focusHeading()
            }}
          />
          <Guide id="getting-started" title="What do you want to track first?" onHide={hide}>
            <ul className="divide-y divide-border rounded-md border border-border">
              {CHOICES.map((choice) => (
                <li key={choice.to}>
                  <Link to={choice.to} className={ROW}>
                    <span className="font-medium">{choice.title}</span>
                    <span className="text-sm text-muted-foreground">{choice.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <ProfileLine userId={userId} />
          </Guide>
        </>
      )}
      {!hidden && step === 2 && links.length > 0 && (
        <Guide id="first-entry" title="Record your first entry" onHide={hide}>
          <ul className="divide-y divide-border rounded-md border border-border">
            {links.map(({ group, to, title }) => (
              <li key={group.$id}>
                <Link to={to} className={ROW}>
                  <span className="font-medium">{title}</span>
                  <span className="text-sm break-words text-muted-foreground">
                    <GroupName group={group} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Guide>
      )}
    </>
  )
}

/**
 * Where a group's first entry is made. Houses come in a follow-up (#52). Shifts pay the group's
 * owner, and archived groups take no entries, so only the user's own open employers get one.
 */
function firstEntryLink(group: Groups, personId: string): { to: string; title: string } | null {
  if (group.archivedAt) return null
  switch (group.type) {
    case 'employer':
      return group.ownerPersonId === personId
        ? { to: `/shifts/new?groupId=${group.$id}`, title: 'Add a shift' }
        : null
    case 'pair':
      return { to: `/people/${group.$id}`, title: 'Record money lent or borrowed' }
    case 'personal':
      return { to: '/bills/new', title: 'Add a bill' }
    default:
      return null
  }
}

function Guide({
  id,
  title,
  onHide,
  children,
}: {
  id: string
  title: string
  onHide: () => void
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-medium">
          {title}
        </h2>
        <Button variant="ghost" size="sm" onClick={onHide}>
          Hide
        </Button>
      </div>
      {children}
    </section>
  )
}

/** What bootstrap guessed from the browser, which a new user may want to change. */
function ProfileLine({ userId }: { userId: string }) {
  const profile = useProfile(userId).data
  if (!profile) return null
  return (
    <p className="text-sm text-muted-foreground">
      We set your time zone to {profile.timezone}, holidays to {profile.region} and currency to{' '}
      {profile.currency}.{' '}
      <Link to="/profile" className="underline underline-offset-4">
        Change in Profile
      </Link>
    </p>
  )
}
