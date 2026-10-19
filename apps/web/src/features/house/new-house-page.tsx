import type { CreateGroupBody } from '@ledgerly/core/schemas/groups'
import { useQueryClient } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'
import { HouseForm } from './house-form'
import { NEW_HOUSE } from './house-values'
import { GroupsError, useCreateHouse } from './use-house'

/** `/groups/new-house` (flow 6, step 1). */
export function NewHousePage() {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const create = useCreateHouse()
  // One ID per visit, so retrying after an error can't create the house twice.
  const [id] = useState(() => ID.unique())

  async function save(body: CreateGroupBody) {
    try {
      const { group } = await create.mutateAsync(body)
      navigate(`/groups/${group.$id}`)
    } catch (error) {
      if (!(error instanceof GroupsError && error.code === 'CONFLICT')) throw error
      // An earlier try with this ID went through and its answer was lost, then the form changed.
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
      throw new Error('This house may already exist. Check Groups, or try again.')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New house</h1>
      <HouseForm mode="create" id={id} defaultValues={NEW_HOUSE} onSave={save} />
    </div>
  )
}
