import type { Transactions } from '@ledgerly/core/generated/rows'
import type { TransactionView } from '@ledgerly/core/schemas/ledger'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ID, Permission, Role } from 'appwrite'
import { client, storage } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { ledger } from '../transactions/use-transactions'

/** appwrite/buckets.json */
export const RECEIPTS_BUCKET = 'receipts'
/** functions-api.md#validation: a transaction's receipts. */
export const MAX_RECEIPTS = 10

/**
 * Uploads a prepared receipt, readable by the group's team only (permissions.md#storage). The
 * ledger function checks it, and narrows it to exactly that, when it's attached.
 */
export async function uploadReceipt(file: File, groupId: string): Promise<string> {
  const uploaded = await storage.createFile({
    bucketId: RECEIPTS_BUCKET,
    fileId: ID.unique(),
    file,
    permissions: [Permission.read(Role.team(groupId))],
  })
  return uploaded.$id
}

/**
 * `POST /transactions/{id}/receipts` with the whole new list. `optimistic` shows it at once and
 * puts the old list back if it's refused (a removal); an addition shows once it's attached.
 */
export function useSetReceipts(row: Transactions) {
  const queryClient = useQueryClient()
  const key = queryKeys.transaction(row.$id)
  return useMutation({
    mutationFn: ({ list }: { list: string[]; optimistic: boolean }) =>
      ledger<TransactionView>('POST', `/transactions/${row.$id}/receipts`, {
        receiptFileIds: list,
      }),
    onMutate: async ({ list, optimistic }) => {
      if (!optimistic) return undefined
      // Only this row: the shares query under the same prefix keeps loading.
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const before = queryClient.getQueryData<Transactions>(key)
      if (before) queryClient.setQueryData(key, { ...before, receiptFileIds: list })
      return { rollback: () => queryClient.setQueryData(key, before) }
    },
    onError: (_error, _input, context) => context?.rollback(),
    onSuccess: (view) => queryClient.setQueryData(key, view.transaction),
  })
}

/**
 * A file's bytes from Storage, with the session the SDK uses. Browsers that block third-party
 * cookies (Safari) send none on an `<img src>` to Appwrite's domain, so the SDK's fallback
 * session header goes along, as it does on the SDK's own requests.
 */
export async function fetchFileBlob(url: string): Promise<Blob> {
  let fallback = ''
  try {
    fallback = localStorage.getItem('cookieFallback') ?? ''
  } catch {
    // No storage: the cookie alone.
  }
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'X-Appwrite-Project': client.config.project,
      ...(fallback ? { 'X-Fallback-Cookies': fallback } : {}),
    },
  })
  if (!response.ok) throw new Error(`Storage answered ${response.status}`)
  return response.blob()
}
