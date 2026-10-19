import type { Statements } from '@ledgerly/core/generated/rows'
import type { VoidStatementBody } from '@ledgerly/core/schemas/statements'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppwriteException, ExecutionMethod, Query, Storage } from 'appwrite'
import { callFunction, type Method, parseEnvelope } from '../../lib/api'
import { client, DATABASE_ID, functions, tablesDB } from '../../lib/appwrite'
import { writeErrorMessage } from '../groups/archive-group'

// Appwrite's limit for one page.
const PAGE = 100
/**
 * How often a finalize is checked on, and how many times: past the statements function's 300 s
 * timeout (appwrite/functions.json), with time to wait for a start. Tests shorten it.
 */
export const finalizeTiming = { pollMs: 2000, polls: 160 }

// An async execution keeps no response body (functions-api.md), so a refusal is known only by
// its status code: these are the finalize route's.
const FINALIZE_REFUSED: Record<number, string> = {
  400: 'This invoice can’t be finalized as it is. Reload the page to see it as it is now.',
  401: 'Please log in again.',
  403: 'Only an admin can finalize this invoice.',
  404: 'This invoice no longer exists. Reload the page.',
  409: 'It couldn’t be finalized yet: an earlier invoice of this group must be finalized first, or something else changed it at the same time. Try again.',
}

// Local to this feature: the shared keys file is outside its Scope.
export const statementKeys = {
  list: (groupId: string) => ['statements', groupId] as const,
  one: (id: string) => ['statement', id] as const,
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
    queryKey: statementKeys.list(groupId),
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
    queryKey: statementKeys.one(id),
    enabled: id !== '',
    queryFn: () =>
      tablesDB.getRow<Statements>({ databaseId: DATABASE_ID, tableId: 'statements', rowId: id }),
  })
}

function store(queryClient: ReturnType<typeof useQueryClient>, statement: Statements) {
  queryClient.setQueryData(statementKeys.one(statement.$id), statement)
  void queryClient.invalidateQueries({ queryKey: statementKeys.list(statement.groupId) })
}

/** `POST /statements/{id}/refresh`: a draft worked out again from the ledger as it is now. */
export function useRefreshStatement(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => statements<Statements>('POST', `/statements/${id}/refresh`),
    onSuccess: (statement) => store(queryClient, statement),
  })
}

/** `POST /statements/{id}/send`: emails a final invoice (again). */
export function useSendStatement(statement: Statements) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => statements<{ sentAt: string }>('POST', `/statements/${statement.$id}/send`),
    onSuccess: ({ sentAt }) => store(queryClient, { ...statement, sentAt }),
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

/** How a finalize ended: the statement as stored, and the error if the execution failed. */
export type FinalizeResult = { statement: Statements; error?: string }

/**
 * `POST /statements/{id}/finalize` as an **async** execution (functions-api.md#statements), then
 * watching both the statement row and the execution until the row is final and the execution has
 * ended, or the execution fails (#32's #88 note: a failed one must never leave the screen
 * spinning). A failure after the row turned final (the email, say) still returns it final.
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
          return {
            statement: row,
            error:
              answer && !answer.ok
                ? writeErrorMessage(answer.error)
                : (FINALIZE_REFUSED[run.responseStatusCode] ?? 'The server stopped with an error.'),
          }
        }
        return {
          statement: await read(),
          error:
            'This is taking longer than usual. Reload the page in a minute to see how it went.',
        }
      } catch (error) {
        throw new Error(
          error instanceof AppwriteException && error.code === 401
            ? 'Please log in again.'
            : 'Could not reach the server. Check your connection and try again.',
        )
      }
    },
    onSuccess: ({ statement: row }) => store(queryClient, row),
    // A watch that failed part way may have missed the row changing: read it again.
    onError: () => queryClient.invalidateQueries({ queryKey: statementKeys.one(statement.$id) }),
  })
}

const storage = new Storage(client)

/**
 * The PDF of a final (or since voided) statement, saved as `<number>.pdf`. Fetched through the SDK, so the
 * session goes with it, then handed to the browser.
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
  link.download = `${statement.displayNumber ?? 'invoice'}.pdf`
  link.click()
  // Later, so the browser has started saving it first.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
