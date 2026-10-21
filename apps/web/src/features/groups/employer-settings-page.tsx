import type { Groups } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema, type UpdateGroupBody } from '@ledgerly/core/schemas/groups'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import {
  ARCHIVED_NOTICE,
  ArchiveGroup,
  DeleteWithoutAdmin,
  UNARCHIVED_NEWS,
  UnarchiveGroup,
  writeErrorMessage,
} from './archive-group'
import { EmployerForm, type EmployerValues, toEmployerValues } from './employer-form'
import { useGroup, useMyMember } from './use-groups'

function parseSettings(json: string) {
  try {
    const parsed = groupSettingsSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

// Undefined when the stored settings can't be read: the form would show defaults, and a save
// would then overwrite the stored rate and billing emails with them.
function formValues(group: Groups): EmployerValues | undefined {
  const settings = parseSettings(group.settingsJson)
  return settings?.type === 'employer' ? toEmployerValues({ ...group, settings }) : undefined
}

function Message({ children, alert = false }: { children: string; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={alert ? 'text-destructive' : 'text-muted-foreground'}
    >
      {children}
    </p>
  )
}

export function EmployerSettingsPage() {
  const groupId = useParams().groupId ?? ''
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const group = useGroup(groupId)
  const member = useMyMember(groupId, personId)
  const queryClient = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const [unarchived, setUnarchived] = useState(false)
  // When the page stops being the admin's (the group turns archived in another tab, the caller is
  // made a member, or a refused save reloads either), the form or dialog that had focus is gone:
  // focus goes to the heading. Only a change while the page is open counts, not how it loaded.
  const adminView =
    group.data !== undefined && !group.data.archivedAt && member.data?.role === 'admin'
  const wasAdminView = useRef(false)
  useEffect(() => {
    if (!adminView && wasAdminView.current && document.activeElement === document.body) {
      heading.current?.focus()
    }
    wasAdminView.current = adminView
  }, [adminView])

  async function save(body: UpdateGroupBody): Promise<EmployerValues> {
    const result = await callFunction<Groups>('groups', 'PATCH', `/groups/${groupId}`, body)
    if (!result.ok) {
      // The group or the caller's role changed: reload them, so the page shows what's true now.
      if (['FORBIDDEN', 'ARCHIVED', 'NOT_A_MEMBER'].includes(result.error.code)) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.myMember(groupId, personId) })
      }
      throw new Error(writeErrorMessage(result.error))
    }
    queryClient.setQueryData(queryKeys.group(groupId), result.data)
    await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    const values = formValues(result.data)
    if (!values) throw new Error('Saved, but the settings couldn’t be read back. Reload the page.')
    return values
  }

  let content: ReactNode
  const values = group.data && formValues(group.data)
  // Errors only when there's nothing to show: a failed background refetch keeps the page, and
  // a half-filled form with it.
  if ((group.isError && !group.data) || (member.isError && member.data === undefined)) {
    content = <Message alert>We couldn’t load this group. Reload the page to try again.</Message>
  } else if (!group.data || member.data === undefined) {
    content = <Message>Loading…</Message>
  } else if (group.data.type !== 'employer') {
    content = <Message>Only employer groups have settings here.</Message>
  } else if (group.data.archivedAt) {
    content = (
      <>
        <Message>{ARCHIVED_NOTICE}</Message>
        {member.data?.role === 'admin' ? (
          <UnarchiveGroup
            group={group.data}
            onUnarchived={() => {
              setUnarchived(true)
              heading.current?.focus()
            }}
          />
        ) : (
          member.data && <DeleteWithoutAdmin group={group.data} personId={member.data.personId} />
        )}
      </>
    )
  } else if (!values) {
    content = (
      <Message alert>
        We couldn’t read this group’s settings, so they can’t be changed here.
      </Message>
    )
  } else {
    const isAdmin = member.data?.role === 'admin'
    content = (
      <>
        {!isAdmin && <Message>Only an admin can change these settings.</Message>}
        <Link
          to={`/groups/${group.data.$id}/statements`}
          className="self-start text-sm underline underline-offset-4"
        >
          Invoices
        </Link>
        <EmployerForm mode="settings" defaultValues={values} readOnly={!isAdmin} onSave={save} />
        {isAdmin && <ArchiveGroup group={group.data} onArchived={() => heading.current?.focus()} />}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold break-words outline-none">
        {group.data?.name ?? 'Employer settings'}
      </h1>
      {/* Mounted with the group, so the news is read out. */}
      {group.data && (
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {unarchived && !group.data.archivedAt ? UNARCHIVED_NEWS : ''}
        </p>
      )}
      {content}
    </div>
  )
}
