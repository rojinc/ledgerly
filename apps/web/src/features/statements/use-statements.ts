import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot, VoidStatementBody } from '@ledgerly/core/schemas/statements'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppwriteException, ExecutionMethod, Query, Storage } from 'appwrite'
import { callFunction, type ErrorCode, type Method, parseEnvelope } from '../../lib/api'
import { client, DATABASE_ID, functions, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { writeErrorMessage } from '../groups/archive-group'

// Appwrite's limit for one page.
const PAGE = 100
/**
 * How often a finalize is checked on, and how many times: past the statements function's 300 s
 * timeout (appwrite/functions.json), with time to wait for a start. Tests shorten it.
 */
export const finalizeTiming = { pollMs: 2000, polls: 160 }

// An async execution keeps no response body (functions-api.md), so a refusal is known only by
// its status code: these are the finalize route's. A divide is never called an invoice
// (statements.md#monthly-divide-pdf-layout-house).
function finalizeRefused(status: number, type: Statements['type']): string | undefined {
  const noun = type === 'divide' ? 'divide' : 'invoice'
  const earlier = type === 'divide' ? 'statement' : 'invoice'
  return {
    400: `This ${noun} can’t be finalized as it is. Reload the page to see it as it is now.`,
    401: 'Please log in again.',
    403: `Only an admin can finalize this ${noun}.`,
    404: `This ${noun} no longer exists. Reload the page.`,
    409: `It couldn’t be finalized yet: an earlier ${earlier} of this group must be finalized first, or something else changed it at the same time. Try again.`,
  }[status]
}

/** Calls the statements function; a refusal throws its message in plain words. */
async function statements<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const result = await callFunction<T>('statements', method, path, body)
  if (!result.ok) throw new Error(writeErrorMessage(result.error))
  return result.data
}

/** A group's statements (`statements.idx_group_period`), latest period first, every page. */
export function useStatements(groupId: string) {
  return useQuery({
    queryKey: queryKeys.statements(groupId),
    enabled: groupId !== '',
    queryFn: async () => {
      const rows: Statements[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await tablesDB.listRows<Statements>({
          databaseId: DATABASE_ID,
          tableId: 'statements',
          queries: [
            Query.equal('groupId', groupId),
            Query.orderDesc('periodStart'),
            Query.limit(PAGE),
            ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
          ],
        })
        rows.push(...page.rows)
        if (page.rows.length < PAGE) return rows
        cursor = page.rows.at(-1)?.$id
      }
    },
  })
}

export function useStatement(id: string) {
  return useQuery({
    queryKey: queryKeys.statement(id),
    enabled: id !== '',
    queryFn: () =>
      tablesDB.getRow<Statements>({ databaseId: DATABASE_ID, tableId: 'statements', rowId: id }),
  })
}

function store(queryClient: ReturnType<typeof useQueryClient>, statement: Statements) {
  queryClient.setQueryData(queryKeys.statement(statement.$id), statement)
  void queryClient.invalidateQueries({ queryKey: queryKeys.statements(statement.groupId) })
}

/**
 * `POST /statements/preview`: what a statement ending on `periodEnd` (default: today in the
 * group's time zone) would hold now, starting where a close's would. Nothing is saved. Under the
 * list's key, so whatever refreshes the list (a close, a finalize, someone else's change)
 * refreshes it too.
 */
export function usePreviewStatement(groupId: string, periodEnd?: string, enabled = true) {
  return useQuery({
    // null for the default, so an emptied date field ('') is never the same query.
    queryKey: [...queryKeys.statements(groupId), 'preview', periodEnd ?? null],
    enabled: enabled && groupId !== '',
    retry: false,
    queryFn: () =>
      statements<{ snapshot: StatementSnapshot }>('POST', '/statements/preview', {
        groupId,
        ...(periodEnd !== undefined && { periodEnd }),
      }),
  })
}

/** A close refused while another draft of the group is unfinished (statements.md#6). */
export class UnfinishedDraft extends Error {
  constructor(readonly draftId: string) {
    super('Finalize or discard the earlier draft first.')
  }
}

/**
 * `POST /statements/close`: drafts the group's next statement now, up to `periodEnd`
 * (statements.md#6). Asking again with the same `periodEnd` returns the same draft.
 */
export function useCloseStatement(groupId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (periodEnd: string) => {
      const result = await callFunction<Statements>('statements', 'POST', '/statements/close', {
        groupId,
        periodEnd,
      })
      if (result.ok) return result.data
      const draftId = (result.error.details as { draftId?: unknown } | undefined)?.draftId
      if (result.error.code === 'CONFLICT' && typeof draftId === 'string') {
        throw new UnfinishedDraft(draftId)
      }
      throw new Error(writeErrorMessage(result.error))
    },
    onSuccess: (statement) => store(queryClient, statement),
    // A close whose answer was lost may still have drafted it.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.statements(groupId) }),
  })
}

/** `POST /statements/{id}/refresh`: a draft worked out again from the ledger as it is now. */
export function useRefreshStatement(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => statements<Statements>('POST', `/statements/${id}/refresh`),
    onSuccess: (statement) => store(queryClient, statement),
    // A refresh whose answer was lost, or that clashed with another, may still have changed it.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.statement(id) }),
  })
}

/** `POST /statements/{id}/send`: emails a final invoice (again). */
export function useSendStatement(statement: Statements) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => statements<{ sentAt: string }>('POST', `/statements/${statement.$id}/send`),
    onSuccess: ({ sentAt }) => store(queryClient, { ...statement, sentAt }),
    // The email may have gone although the answer was lost: show Send again if so.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.statement(statement.$id) }),
  })
}

/** `POST /statements/{id}/void`: the group's latest final statement only. */
export function useVoidStatement(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VoidStatementBody) =>
      statements<Statements>('POST', `/statements/${id}/void`, body),
    onSuccess: (statement) => store(queryClient, statement),
  })
}

/**
 * How a finalize ended: the statement as stored, and if the execution failed, the error, its
 * code when the answer kept one, and its status code.
 */
export type FinalizeResult = {
  statement: Statements
  error?: string
  code?: ErrorCode
  status?: number
}

/** The statement was deleted meanwhile: another admin discarded the draft. */
export class StatementGone extends Error {}

/**
 * `POST /statements/{id}/finalize` as an **async** execution (functions-api.md#statements): polls
 * the execution until it ends, then reads the row (#32's #88 note: a failed one must never leave
 * the screen spinning). A failure after the row turned final (the email, say) still returns it
 * final.
 */
export function useFinalizeStatement(statement: Statements) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (send: boolean): Promise<FinalizeResult> => {
      const read = () =>
        tablesDB.getRow<Statements>({
          databaseId: DATABASE_ID,
          tableId: 'statements',
          rowId: statement.$id,
        })
      try {
        const execution = await functions.createExecution({
          functionId: 'statements',
          body: JSON.stringify({ send }),
          async: true,
          xpath: `/statements/${statement.$id}/finalize`,
          method: ExecutionMethod.POST,
        })
        for (let poll = 0; poll < finalizeTiming.polls; poll++) {
          await new Promise((resolve) => setTimeout(resolve, finalizeTiming.pollMs))
          const run = await functions.getExecution({
            functionId: 'statements',
            executionId: execution.$id,
          })
          const ended = run.status === 'completed' || run.status === 'failed'
          if (!ended) continue
          const row = await read()
          if (run.status === 'completed' && run.responseStatusCode < 400) return { statement: row }
          const answer = run.responseBody ? parseEnvelope(run) : undefined
          const refusal = answer && !answer.ok ? answer.error : undefined
          return {
            statement: row,
            error: refusal
              ? writeErrorMessage(refusal)
              : (finalizeRefused(run.responseStatusCode, statement.type) ??
                'The server stopped with an error.'),
            ...(refusal && { code: refusal.code }),
            status: run.responseStatusCode,
          }
        }
        return {
          statement: await read(),
          error:
            'This is taking longer than usual. Reload the page in a minute to see how it went.',
        }
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404) {
          throw new StatementGone('This statement no longer exists.')
        }
        throw new Error(
          error instanceof AppwriteException && error.code === 401
            ? 'Please log in again.'
            : 'Could not reach the server. Check your connection and try again.',
        )
      }
    },
    onSuccess: ({ statement: row }) => store(queryClient, row),
    onError: (error) => {
      if (error instanceof StatementGone) {
        queryClient.removeQueries({ queryKey: queryKeys.statement(statement.$id) })
        return queryClient.invalidateQueries({ queryKey: queryKeys.statements(statement.groupId) })
      }
      // A watch that failed part way may have missed the row changing: read it again.
      return queryClient.invalidateQueries({ queryKey: queryKeys.statement(statement.$id) })
    },
  })
}

/**
 * `POST /statements/{id}/discard`: deletes a draft (statements.md#5). Asking again gets
 * `NOT_FOUND`, which counts as done: an earlier try's answer may have been lost.
 */
export function useDiscardStatement(statement: Statements) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const result = await callFunction<object>(
        'statements',
        'POST',
        `/statements/${statement.$id}/discard`,
      )
      if (!result.ok && result.error.code !== 'NOT_FOUND') {
        throw new Error(writeErrorMessage(result.error))
      }
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.statement(statement.$id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.statements(statement.groupId) })
    },
    // It may have been discarded although the answer was lost, or changed by someone else.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.statement(statement.$id) }),
  })
}

const storage = new Storage(client)

/**
 * The PDF of a final (or since voided) statement, saved as `<number>.pdf`, or
 * `divide-<periodEnd>.pdf` for a divide (statements.md#2, step 7). Fetched through the SDK, so
 * the session goes with it, then handed to the browser.
 */
export async function downloadPdf(statement: Statements): Promise<void> {
  const url = storage.getFileDownload({
    bucketId: 'statements',
    fileId: statement.pdfFileId ?? '',
  })
  const bytes: ArrayBuffer = await client.call('get', new URL(url), {}, {}, 'arrayBuffer')
  const href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = href
  link.download =
    statement.type === 'divide'
      ? `divide-${statement.periodEnd}.pdf`
      : `${statement.displayNumber ?? 'invoice'}.pdf`
  link.click()
  // Later, so the browser has started saving it first.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
