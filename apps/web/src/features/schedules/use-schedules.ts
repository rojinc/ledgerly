import type { Schedules } from '@ledgerly/core/generated/rows'
import {
  type endScheduleBodySchema,
  previewScheduleBodySchema,
  type ScheduleInput,
} from '@ledgerly/core/schemas/scheduler'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { callFunction, type Method } from '../../lib/api'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { writeErrorMessage } from '../groups/archive-group'

// Appwrite's limit for one page.
const PAGE = 100
// How long the form waits after the last change before asking for a preview.
const PREVIEW_DELAY_MS = 400

// Local to this feature: the shared keys file is outside its Scope.
export const scheduleKeys = {
  list: (groupId: string) => ['schedules', groupId] as const,
  one: (id: string) => ['schedule', id] as const,
  preview: (body: PreviewInput | undefined) => ['schedulePreview', body] as const,
}

/** The preview body as the form builds it; the hook checks it before sending. */
type PreviewInput = z.input<typeof previewScheduleBodySchema>

/** What `POST /schedules/preview` answers (functions-api.md#scheduler). */
export type Preview = {
  dates: string[]
  skipped: { date: string; reason: 'exdate' | 'holiday' }[]
}

/** Calls the scheduler function; a refusal throws its message in plain words. */
async function scheduler<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const result = await callFunction<T>('scheduler', method, path, body)
  if (!result.ok) throw new Error(writeErrorMessage(result.error))
  return result.data
}

/** A group's schedules (`schedules.idx_groupId`), readable by its team, oldest first. */
export function useSchedules(groupId: string) {
  return useQuery({
    queryKey: scheduleKeys.list(groupId),
    enabled: groupId !== '',
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Schedules>({
        databaseId: DATABASE_ID,
        tableId: 'schedules',
        queries: [Query.equal('groupId', groupId), Query.orderAsc('startsOn'), Query.limit(PAGE)],
      })
      return rows
    },
  })
}

export function useSchedule(id: string) {
  return useQuery({
    queryKey: scheduleKeys.one(id),
    enabled: id !== '',
    queryFn: () =>
      tablesDB.getRow<Schedules>({ databaseId: DATABASE_ID, tableId: 'schedules', rowId: id }),
  })
}

/** `value`, once it has stopped changing for `delay` ms. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  const key = JSON.stringify(value)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `value`'s content.
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [key, delay])
  return settled
}

/**
 * The next dates the schedule would create, and those it skips, while the form is filled in.
 * Asks only once the input stops changing and the schema accepts it, and keeps the last answer
 * on screen meanwhile.
 */
export function usePreview(body: PreviewInput | undefined) {
  const settled = useSettled(body, PREVIEW_DELAY_MS)
  const valid = settled !== undefined && previewScheduleBodySchema.safeParse(settled).success
  return useQuery({
    queryKey: scheduleKeys.preview(settled),
    enabled: valid,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () => scheduler<Preview>('POST', '/schedules/preview', settled),
  })
}

/** `POST /schedules`, or `PATCH /schedules/{id}` for an existing one. */
export function useSaveSchedule(isNew: boolean) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) =>
      isNew
        ? scheduler<{ schedule: Schedules }>('POST', '/schedules', input)
        : scheduler<{ schedule: Schedules }>('PATCH', `/schedules/${input.id}`, input),
    onSuccess: ({ schedule }) => refresh(queryClient, schedule),
  })
}

/** `POST /schedules/{id}/end`: no occurrences after `endsOn`. */
export function useEndSchedule(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: z.input<typeof endScheduleBodySchema>) =>
      scheduler<{ schedule: Schedules }>('POST', `/schedules/${id}/end`, body),
    onSuccess: ({ schedule }) => refresh(queryClient, schedule),
  })
}

// A schedule's change adds or removes occurrences: the calendar and history are out of date.
function refresh(queryClient: ReturnType<typeof useQueryClient>, schedule: Schedules) {
  queryClient.setQueryData(scheduleKeys.one(schedule.$id), schedule)
  void queryClient.invalidateQueries({ queryKey: scheduleKeys.list(schedule.groupId) })
  void queryClient.invalidateQueries({ queryKey: ['calendar'] })
  void queryClient.invalidateQueries({ queryKey: ['history', schedule.groupId] })
}
