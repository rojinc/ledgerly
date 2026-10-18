import type { Groups, Members } from '@ledgerly/core/generated/rows'
import type { CreateGroupBody } from '@ledgerly/core/schemas/groups'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
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
  const bootstrap = useBootstrap(userId)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // One ID per visit, so retrying after an error can't create the group twice.
  const [id] = useState(() => ID.unique())

  async function create(body: CreateGroupBody) {
    const result = await callFunction<{ group: Groups; members: Members[] }>(
      'groups',
      'POST',
      '/groups',
      body,
    )
    if (!result.ok) throw new Error(result.error.message)
    const { group } = result.data
    queryClient.setQueryData(queryKeys.group(group.$id), group)
    await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    navigate(`/groups/${group.$id}/settings`)
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New employer</h1>
      {bootstrap.data ? (
        <EmployerForm
          mode="create"
          id={id}
          // The group takes the currency from the profile, so amounts are parsed in it.
          currency={bootstrap.data.profile.currency}
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
