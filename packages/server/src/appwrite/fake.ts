import { AppwriteException, type Models } from 'node-appwrite'
import type { Db } from './client'
import { DATABASE_ID } from './tables'

type Row = Record<string, unknown> & { $id: string }
type Query = { method: string; attribute?: string; values?: unknown[] }
type Operation = {
  action: string
  databaseId: string
  tableId: string
  rowId: string
  data?: unknown
}
type Transaction = Models.Transaction & { staged: Operation[] }

// Appwrite's default page size when a query has no limit.
const DEFAULT_LIMIT = 25

/**
 * In-memory TablesDB for tests. Reads take the same `Query` strings as Appwrite. Transactions
 * stage `createOperations` and apply them all or nothing on commit. Not modelled: column
 * validation, conflicts with writes from outside a transaction, and reads that see staged
 * changes. Seed rows may set `$createdAt`; other system fields are filled in.
 */
export class FakeDb implements Db {
  private tables = new Map<string, Map<string, Row>>()
  private transactions = new Map<string, Transaction>()
  private sequence = 0

  constructor(seed: Record<string, Array<Record<string, unknown> & { $id: string }>> = {}) {
    for (const [tableId, rows] of Object.entries(seed)) {
      for (const row of rows) insert(this.tables, tableId, row, this.nextSequence())
    }
  }

  /** Every row in a table, in insertion order, for assertions. */
  rows(tableId: string): Row[] {
    return [...this.table(tableId).values()].map((row) => structuredClone(row))
  }

  async getRow<R extends Models.Row>(params: {
    databaseId: string
    tableId: string
    rowId: string
  }): Promise<R> {
    checkDatabase(params.databaseId)
    const row = this.table(params.tableId).get(params.rowId)
    if (!row) throw rowNotFound(params.tableId, params.rowId)
    return structuredClone(row) as unknown as R
  }

  async listRows<R extends Models.Row>(params: {
    databaseId: string
    tableId: string
    queries?: string[]
  }): Promise<Models.RowList<R>> {
    checkDatabase(params.databaseId)
    const queries = (params.queries ?? []).map((query) => JSON.parse(query) as Query)
    let rows = [...this.table(params.tableId).values()]
    let limit = DEFAULT_LIMIT
    let offset = 0
    let cursorAfter: unknown
    const orders: Array<{ attribute: string; direction: 1 | -1 }> = []
    for (const query of queries) {
      const { method, attribute = '', values = [] } = query
      switch (method) {
        case 'limit':
          limit = Number(values[0])
          break
        case 'offset':
          offset = Number(values[0])
          break
        case 'cursorAfter':
          cursorAfter = values[0]
          break
        case 'orderAsc':
        case 'orderDesc':
          orders.push({ attribute, direction: method === 'orderAsc' ? 1 : -1 })
          break
        default:
          rows = rows.filter((row) => matches(row[attribute], method, values))
      }
    }
    if (orders.length > 0) {
      rows.sort((a, b) => {
        for (const { attribute, direction } of orders) {
          const order = compare(a[attribute], b[attribute])
          if (order !== 0) return order * direction
        }
        return 0
      })
    }
    const total = rows.length
    if (cursorAfter !== undefined) {
      const index = rows.findIndex((row) => row.$id === cursorAfter)
      if (index === -1)
        throw new AppwriteException('Cursor row not found', 400, 'general_cursor_not_found')
      rows = rows.slice(index + 1)
    }
    const page = rows.slice(offset, offset + limit)
    return { total, rows: page.map((row) => structuredClone(row) as unknown as R) }
  }

  async createTransaction(): Promise<Models.Transaction> {
    const now = new Date().toISOString()
    const transaction: Transaction = {
      $id: `tx${this.transactions.size + 1}`,
      $createdAt: now,
      $updatedAt: now,
      status: 'pending',
      operations: 0,
      expiresAt: new Date(Date.parse(now) + 300_000).toISOString(),
      staged: [],
    }
    this.transactions.set(transaction.$id, transaction)
    return publicTransaction(transaction)
  }

  async createOperations(params: {
    transactionId: string
    operations?: object[]
  }): Promise<Models.Transaction> {
    const transaction = this.pendingTransaction(params.transactionId)
    for (const operation of (params.operations ?? []) as Operation[]) {
      if (!['create', 'update', 'upsert', 'delete'].includes(operation.action)) {
        throw new Error(`FakeDb does not support the "${operation.action}" operation`)
      }
      checkDatabase(operation.databaseId)
      transaction.staged.push(structuredClone(operation))
    }
    transaction.operations = transaction.staged.length
    return publicTransaction(transaction)
  }

  async updateTransaction(params: {
    transactionId: string
    commit?: boolean
    rollback?: boolean
  }): Promise<Models.Transaction> {
    const transaction = this.pendingTransaction(params.transactionId)
    if (params.rollback) {
      transaction.status = 'rolled_back'
      return publicTransaction(transaction)
    }
    // Apply to a copy and swap it in only if every operation succeeds: all or nothing.
    const tables = structuredClone(this.tables)
    try {
      for (const operation of transaction.staged) {
        apply(tables, operation, () => this.nextSequence())
      }
    } catch (error) {
      transaction.status = 'failed'
      throw error
    }
    this.tables = tables
    transaction.status = 'committed'
    return publicTransaction(transaction)
  }

  private table(tableId: string): Map<string, Row> {
    let table = this.tables.get(tableId)
    if (!table) {
      table = new Map()
      this.tables.set(tableId, table)
    }
    return table
  }

  private pendingTransaction(transactionId: string): Transaction {
    const transaction = this.transactions.get(transactionId)
    if (!transaction) {
      throw new AppwriteException('Transaction not found', 404, 'transaction_not_found')
    }
    if (transaction.status !== 'pending') {
      throw new AppwriteException(
        `Transaction is ${transaction.status}`,
        400,
        'transaction_not_ready',
      )
    }
    return transaction
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }
}

function apply(
  tables: Map<string, Map<string, Row>>,
  operation: Operation,
  nextSequence: () => number,
): void {
  const table = tables.get(operation.tableId) ?? new Map<string, Row>()
  tables.set(operation.tableId, table)
  const existing = table.get(operation.rowId)
  const data = (operation.data ?? {}) as Record<string, unknown>
  switch (operation.action) {
    case 'create':
      if (existing) {
        throw new AppwriteException(
          `Row with the requested ID ${operation.rowId} already exists`,
          409,
          'row_already_exists',
        )
      }
      insert(tables, operation.tableId, { ...data, $id: operation.rowId }, nextSequence())
      return
    case 'upsert':
      if (!existing) {
        insert(tables, operation.tableId, { ...data, $id: operation.rowId }, nextSequence())
        return
      }
      table.set(operation.rowId, update(existing, data))
      return
    case 'update':
      if (!existing) throw rowNotFound(operation.tableId, operation.rowId)
      table.set(operation.rowId, update(existing, data))
      return
    case 'delete':
      if (!existing) throw rowNotFound(operation.tableId, operation.rowId)
      table.delete(operation.rowId)
      return
  }
}

function insert(
  tables: Map<string, Map<string, Row>>,
  tableId: string,
  data: Record<string, unknown> & { $id: string },
  sequence: number,
): void {
  const table = tables.get(tableId) ?? new Map<string, Row>()
  tables.set(tableId, table)
  const now = new Date().toISOString()
  table.set(data.$id, {
    $createdAt: now,
    $updatedAt: now,
    $permissions: [],
    ...structuredClone(data),
    $sequence: String(sequence),
    $tableId: tableId,
    $databaseId: DATABASE_ID,
  })
}

function update(existing: Row, data: Record<string, unknown>): Row {
  return { ...existing, ...structuredClone(data), $updatedAt: new Date().toISOString() }
}

function matches(value: unknown, method: string, values: unknown[]): boolean {
  switch (method) {
    case 'equal':
      return values.some((candidate) => candidate === value)
    case 'notEqual':
      return values.every((candidate) => candidate !== value)
    case 'isNull':
      return value === null || value === undefined
    case 'isNotNull':
      return value !== null && value !== undefined
    case 'lessThan':
      return value != null && compare(value, values[0]) < 0
    case 'lessThanEqual':
      return value != null && compare(value, values[0]) <= 0
    case 'greaterThan':
      return value != null && compare(value, values[0]) > 0
    case 'greaterThanEqual':
      return value != null && compare(value, values[0]) >= 0
    case 'between':
      return value != null && compare(value, values[0]) >= 0 && compare(value, values[1]) <= 0
    default:
      throw new Error(`FakeDb does not support the "${method}" query`)
  }
}

// Nulls sort first, like Appwrite.
function compare(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function checkDatabase(databaseId: string): void {
  if (databaseId !== DATABASE_ID) {
    throw new AppwriteException('Database not found', 404, 'database_not_found')
  }
}

function rowNotFound(tableId: string, rowId: string): AppwriteException {
  return new AppwriteException(
    `Row with the requested ID ${rowId} could not be found in ${tableId}`,
    404,
    'row_not_found',
  )
}

function publicTransaction({ staged: _staged, ...transaction }: Transaction): Models.Transaction {
  return { ...transaction }
}
