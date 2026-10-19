import type { CreateGroupBody, CreateGroupResult } from '@ledgerly/core/schemas/groups'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'
import { useProfile } from '../profile/use-profile'
import { EmployerForm, type EmployerValues } from './employer-form'

const DEFAULTS: EmployerValues = {
  name: '',
  recipients: '',
  defaultRate: '',
  statementCycle: 'monthly',
  cycleAnchor: '',
  paymentTermsDays: '14',
  autoFinalize: false,
}

export function NewEmployerPage() {
  // RequireAuth renders this page only for a signed-in, bootstrapped user.
  const userId = useCurrentUser().data?.$id ?? ''
  // Not the bootstrap copy, which keeps the currency from before a profile change.
  const profile = useProfile(userId)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // One ID per visit, so retrying after an error can't create the group twice.
  const [id] = useState(() => ID.unique())

  async function create(body: CreateGroupBody) {
    const result = await callFunction<CreateGroupResult>('groups', 'POST', '/groups', body)
    if (!result.ok) {
      if (result.error.code !== 'CONFLICT') throw new Error(result.error.message)
      // Either a clash with another write, or an earlier try with this ID went through
      // and its answer was lost (then the ID is taken by that group).
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
      throw new Error('This employer may already exist. Check Groups, or try again.')
    }
    const { group } = result.data
    queryClient.setQueryData(queryKeys.group(group.$id), group)
    await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    navigate(`/groups/${group.$id}/settings`)
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New employer</h1>
      {profile.isError && !profile.data ? (
        <p role="alert" className="text-destructive">
          We couldn’t load your profile. Reload the page to try again.
        </p>
      ) : profile.data ? (
        <EmployerForm
          mode="create"
          id={id}
          // Sent with the body, so the group has the currency the rate was typed in.
          currency={profile.data.currency}
          defaultValues={DEFAULTS}
          onSave={create}
        />
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      )}
    </div>
  )
}
