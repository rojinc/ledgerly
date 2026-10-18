import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATABASE_ID, TABLES } from './tables'

describe('TABLES', () => {
  it('names every table in appwrite/tables.json, in the same database', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../../../appwrite/tables.json', import.meta.url), 'utf8'),
    ) as Array<{ $id: string; databaseId: string }>
    expect(Object.values(TABLES)).toEqual(schema.map((table) => table.$id))
    expect(new Set(schema.map((table) => table.databaseId))).toEqual(new Set([DATABASE_ID]))
    for (const [key, id] of Object.entries(TABLES)) expect(key).toBe(id)
  })
})
