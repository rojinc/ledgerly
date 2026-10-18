import { AppwriteException, type Models } from 'node-appwrite'
import schema from '../../../../appwrite/tables.json' with { type: 'json' }
import type { Db } from './client'
import { DATABASE_ID } from './tables'

type Row = Record<string, unknown> & { $id: string }
type Tables = Map<string, Map<string, Row>>
type Query = { method: string; attribute?: string; values?: unknown[] }
type Operation = {
  action: string
  databaseId: string
  tableId: string
  rowId: string
  data?: unknown
}
// `seen` is the row's version when the operation was staged, for conflict detection.
type Transaction = Models.Transaction & { staged: Array<Operation & { seen: number }> }

// Appwrite's default page size when a query has no limit.
const DEFAULT_LIMIT = 25

// The columns, required columns and unique indexes of every table in appwrite/tables.json.
const TABLE_SCHEMAS = new Map(
  schema.map((table) => [
    table.$id,
    {
      columns: new Set(table.columns.map((column) => column.key)),
      required: table.columns.filter((column) => column.required).map((column) => column.key),
      unique: table.indexes
        .filter((index) => index.type === 'unique')
        .map((index) => index.columns),
    },
  ]),
)
const SYSTEM_COLUMNS = new Set(['$id', '$createdAt', '$updatedAt', '$sequence'])

/**
 * In-memory TablesDB for tests, with the tables, columns and unique indexes of
 * appwrite/tables.json. Reads take the same `Query` strings as Appwrite, and see a
 * transaction's staged writes when given its `transactionId`. Written rows must use known
 * columns and fill the required ones. Transactions apply all or nothing on commit, and fail
 * with 409 when a staged row changed after it was staged, as on Appwrite. Not modelled:
 * column types and sizes, and permissions. Seed rows are not checked and may set `$createdAt`.
 */
export class FakeDb implements Db {
  private tables: Tables = new Map()
  private versions = new Map<string, number>()
  private transactions = new Map<string, Transaction>()
  private sequence = 0

  constructor(seed: Record<string, Array<Record<string, unknown> & { $id: string }>> = {}) {
    for (const [tableId, rows] of Object.entries(seed)) {
      for (const row of rows) insert(this.tables, tableId, row, this.nextSequence())
    }
  }

  /** Every row in a table, in insertion order, for assertions. */
  rows(tableId: string): Row[] {
    return [...rowsOf(this.tables, tableId).values()].map((row) => structuredClone(row))
  }

  async getRow<R extends Models.Row>(params: {
    databaseId: string
    tableId: string
    rowId: string
    transactionId?: string
  }): Promise<R> {
    checkDatabase(params.databaseId)
    const row = rowsOf(this.view(params.transactionId), params.tableId).get(params.rowId)
    if (!row) throw rowNotFound(params.tableId, params.rowId)
    return structuredClone(row) as unknown as R
  }

  async listRows<R extends Models.Row>(params: {
    databaseId: string
    tableId: string
    queries?: string[]
    transactionId?: string
  }): Promise<Models.RowList<R>> {
    checkDatabase(params.databaseId)
    const queries = (params.queries ?? []).map((query) => JSON.parse(query) as Query)
    let rows = [...rowsOf(this.view(params.transactionId), params.tableId).values()]
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
          checkQueryColumn(params.tableId, attribute)
          orders.push({ attribute, direction: method === 'orderAsc' ? 1 : -1 })
          break
        default:
          checkQueryColumn(params.tableId, attribute)
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
      checkTable(operation.tableId)
      const seen = this.version(operation.tableId, operation.rowId)
      // Through JSON, as the SDK sends it, so `undefined` keys are dropped.
      transaction.staged.push({ ...(JSON.parse(JSON.stringify(operation)) as Operation), seen })
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
    let tables: Tables
    try {
      for (const { tableId, rowId, seen } of transaction.staged) {
        if (this.version(tableId, rowId) !== seen) {
          throw new AppwriteException(
            `Row ${rowId} in ${tableId} changed after it was staged`,
            409,
            'transaction_conflict',
          )
        }
      }
      // Apply to a copy and swap it in only if every operation succeeds: all or nothing.
      tables = withStaged(this.tables, transaction.staged, () => this.nextSequence())
    } catch (error) {
      transaction.status = 'failed'
      throw error
    }
    this.tables = tables
    for (const { tableId, rowId } of transaction.staged) {
      this.versions.set(`${tableId}/${rowId}`, this.version(tableId, rowId) + 1)
    }
    transaction.status = 'committed'
    return publicTransaction(transaction)
  }

  // The tables as a transaction sees them: committed rows with its staged writes applied.
  private view(transactionId: string | undefined): Tables {
    if (transactionId === undefined) return this.tables
    const { staged } = this.pendingTransaction(transactionId)
    return withStaged(this.tables, staged, () => 0)
  }

  private version(tableId: string, rowId: string): number {
    return this.versions.get(`${tableId}/${rowId}`) ?? 0
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

function withStaged(tables: Tables, staged: Operation[], nextSequence: () => number): Tables {
  const copy = structuredClone(tables)
  for (const operation of staged) apply(copy, operation, nextSequence)
  for (const tableId of new Set(staged.map((operation) => operation.tableId))) {
    checkUnique(copy, tableId)
  }
  return copy
}

function apply(tables: Tables, operation: Operation, nextSequence: () => number): void {
  const { tableId, rowId } = operation
  const table = rowsOf(tables, tableId)
  const existing = table.get(rowId)
  const data = (operation.data ?? {}) as Record<string, unknown>
  switch (operation.action) {
    case 'create':
      if (existing) throw alreadyExists(`Row with the requested ID ${rowId}`)
      checkData(tableId, data, true)
      insert(tables, tableId, { ...data, $id: rowId }, nextSequence())
      return
    case 'upsert':
      // Appwrite replaces the whole row: columns missing from `data` are not kept.
      checkData(tableId, data, true)
      if (!existing) {
        insert(tables, tableId, { ...data, $id: rowId }, nextSequence())
        return
      }
      table.set(rowId, {
        ...systemFields(existing),
        ...structuredClone(data),
        $updatedAt: new Date().toISOString(),
      })
      return
    case 'update':
      if (!existing) throw rowNotFound(tableId, rowId)
      checkData(tableId, data, false)
      table.set(rowId, {
        ...existing,
        ...structuredClone(data),
        $updatedAt: new Date().toISOString(),
      })
      return
    case 'delete':
      if (!existing) throw rowNotFound(tableId, rowId)
      table.delete(rowId)
      return
  }
}

// Appwrite refuses data with an unknown column or a required column that is missing (for a
// whole row) or null.
function checkData(tableId: string, data: Record<string, unknown>, wholeRow: boolean): void {
  const { columns, required } = tableSchema(tableId)
  const unknown = Object.keys(data).find((key) => !key.startsWith('$') && !columns.has(key))
  const missing = required.find((column) => (wholeRow || column in data) && data[column] == null)
  if (unknown || missing) {
    throw new AppwriteException(
      `Invalid row structure in ${tableId}: ${unknown ? `unknown column ${unknown}` : `missing required column ${missing}`}`,
      400,
      'document_invalid_structure',
    )
  }
}

function insert(
  tables: Tables,
  tableId: string,
  data: Record<string, unknown> & { $id: string },
  sequence: number,
): void {
  const now = new Date().toISOString()
  rowsOf(tables, tableId).set(data.$id, {
    $createdAt: now,
    $updatedAt: now,
    $permissions: [],
    ...structuredClone(data),
    $sequence: String(sequence),
    $tableId: tableId,
    $databaseId: DATABASE_ID,
  })
}

function systemFields(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith('$'))) as Row
}

// Like MariaDB, a unique index ignores rows where any of its columns is null.
function checkUnique(tables: Tables, tableId: string): void {
  for (const columns of tableSchema(tableId).unique) {
    const seen = new Set<string>()
    for (const row of rowsOf(tables, tableId).values()) {
      const values = columns.map((column) => row[column])
      if (values.some((value) => value == null)) continue
      const key = JSON.stringify(values)
      if (seen.has(key)) throw alreadyExists(`A row in ${tableId} with this ${columns.join(', ')}`)
      seen.add(key)
    }
  }
}

function rowsOf(tables: Tables, tableId: string): Map<string, Row> {
  checkTable(tableId)
  let table = tables.get(tableId)
  if (!table) {
    table = new Map()
    tables.set(tableId, table)
  }
  return table
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

function checkTable(tableId: string): void {
  tableSchema(tableId)
}

function tableSchema(tableId: string) {
  const table = TABLE_SCHEMAS.get(tableId)
  if (!table) throw new AppwriteException(`Table ${tableId} not found`, 404, 'table_not_found')
  return table
}

function checkQueryColumn(tableId: string, column: string): void {
  if (!SYSTEM_COLUMNS.has(column) && !tableSchema(tableId).columns.has(column)) {
    throw new AppwriteException(
      `Column ${column} not found in ${tableId}`,
      400,
      'general_query_invalid',
    )
  }
}

function rowNotFound(tableId: string, rowId: string): AppwriteException {
  return new AppwriteException(
    `Row with the requested ID ${rowId} could not be found in ${tableId}`,
    404,
    'row_not_found',
  )
}

function alreadyExists(what: string): AppwriteException {
  return new AppwriteException(`${what} already exists`, 409, 'row_already_exists')
}

function publicTransaction({ staged: _staged, ...transaction }: Transaction): Models.Transaction {
  return { ...transaction }
}
