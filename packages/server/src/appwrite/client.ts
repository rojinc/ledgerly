import { Client, type Models, TablesDB } from 'node-appwrite'

/**
 * The parts of TablesDB that functions use. The real `TablesDB` and `FakeDb` (fake.ts) both
 * satisfy it. Every write goes through `withTransaction()` (transaction.ts), so there are no
 * single-row write methods here.
 */
export interface Db {
  getRow<R extends Models.Row>(params: {
    databaseId: string
    tableId: string
    rowId: string
    queries?: string[]
    transactionId?: string
  }): Promise<R>
  listRows<R extends Models.Row>(params: {
    databaseId: string
    tableId: string
    queries?: string[]
    transactionId?: string
    total?: boolean
  }): Promise<Models.RowList<R>>
  createTransaction(params?: { ttl?: number }): Promise<Models.Transaction>
  createOperations(params: {
    transactionId: string
    operations?: object[]
  }): Promise<Models.Transaction>
  updateTransaction(params: {
    transactionId: string
    commit?: boolean
    rollback?: boolean
  }): Promise<Models.Transaction>
}

/**
 * A server client for this execution: the function's endpoint and project, and the
 * per-execution API key that Appwrite sends in the `x-appwrite-key` header.
 */
export function clientFromRequest(headers: Record<string, string>): Client {
  const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT
  const project = process.env.APPWRITE_FUNCTION_PROJECT_ID
  const key = headers['x-appwrite-key']
  if (!endpoint || !project) {
    throw new Error('APPWRITE_FUNCTION_API_ENDPOINT and APPWRITE_FUNCTION_PROJECT_ID must be set')
  }
  if (!key) throw new Error('The x-appwrite-key header is missing')
  return new Client().setEndpoint(endpoint).setProject(project).setKey(key)
}

export function dbFromRequest(headers: Record<string, string>): Db {
  return new TablesDB(clientFromRequest(headers))
}
