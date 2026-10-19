import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATABASE_ID, TABLES } from './tables'

type Column = { key: string; type: string; format?: string }

const schema = JSON.parse(
  readFileSync(new URL('../../../../appwrite/tables.json', import.meta.url), 'utf8'),
) as Array<{ $id: string; databaseId: string; columns: Column[] }>

describe('TABLES', () => {
  it('names every table in appwrite/tables.json, in the same database', () => {
    expect(Object.values(TABLES)).toEqual(schema.map((table) => table.$id))
    expect(new Set(schema.map((table) => table.databaseId))).toEqual(new Set([DATABASE_ID]))
    for (const [key, id] of Object.entries(TABLES)) expect(key).toBe(id)
  })
})

describe('appwrite/tables.json', () => {
  // Appwrite reports a plain text column as `varchar` and an enum as `string`. A column the file
  // types differently makes the deploy's `push table --force` delete and recreate it, losing
  // its data (it happened to profiles.hoursCapStartsOn).
  it('types every text column as Appwrite reports it', () => {
    const mistyped = schema.flatMap((table) =>
      table.columns
        .filter((column) => column.type === 'string' && column.format !== 'enum')
        .map((column) => `${table.$id}.${column.key}`),
    )
    expect(mistyped).toEqual([])
  })
})
