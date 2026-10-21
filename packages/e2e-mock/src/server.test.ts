import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Query } from 'node-appwrite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Port 0 for the listeners the mock starts on import, so they never take an e2e run's port.
process.env.MOCK_PORT = '0'
const { handleRequest } = await import('./server')

const server = http.createServer((req, res) => void handleRequest(req, res))
let origin = ''
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

async function call(method: string, path: string, body?: object, cookie = '') {
  const response = await fetch(`${origin}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body && { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json(), response }
}

const search = (queries: string[]) =>
  queries.map((query) => `queries[]=${encodeURIComponent(query)}`).join('&')
const rows = (table: string, ...queries: string[]) =>
  call('GET', `/tablesdb/main/tables/${table}/rows?${search(queries)}`)
// Row g1 isn't there: the queries are checked first.
const row = (query: string) =>
  call('GET', `/tablesdb/main/tables/groups/rows/g1?${search([query])}`)

async function unhandled(): Promise<number> {
  return ((await (await fetch(`${origin}/mock/stats`)).json()) as { unhandled: number }).unhandled
}

const refused = { status: 400, body: { type: 'general_query_invalid' } }

describe("the browser's TablesDB reads", () => {
  it('serves the columns of tables.json and the system ones', async () => {
    const read = await rows(
      'transactions',
      Query.equal('groupId', 'g1'),
      Query.contains('description', 'rent'),
      Query.orderDesc('date'),
      Query.orderAsc('$sequence'),
      Query.select(['$id', 'date']),
    )
    expect(read).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
  })

  it('refuses a column the table lacks, in a filter, an order or a select, as FakeDb does', async () => {
    const before = await unhandled()
    expect(await rows('transactions', Query.equal('nope', 'x'))).toMatchObject(refused)
    expect(await rows('transactions', Query.orderAsc('nope'))).toMatchObject(refused)
    expect(await rows('transactions', Query.select(['$id', 'nope']))).toMatchObject(refused)
    expect(await row(Query.select(['nope']))).toMatchObject(refused)
    expect(await unhandled()).toBe(before)
  })

  it('refuses an `equal` with no values', async () => {
    expect(await rows('transactions', Query.equal('$id', []))).toMatchObject(refused)
  })

  it('counts a query it does not model as a gap, which fails the run', async () => {
    const before = await unhandled()
    expect(await rows('transactions', Query.search('description', 'rent'))).toMatchObject(refused)
    expect(await rows('transactions', Query.startsWith('description', 'R'))).toMatchObject(refused)
    expect(await row(Query.limit(1))).toMatchObject(refused)
    // On a table no row of which is readable too, where no filter ever runs (AI A on #570).
    expect(await rows('reminders', Query.notContains('groupId', 'g1'))).toMatchObject(refused)
    expect(await unhandled()).toBe(before + 4)
  })
})

describe("the runner's Users reads", () => {
  it('pick the selected columns, as a row read does (AI A on #570)', async () => {
    await call('POST', '/account', {
      userId: 'unique()',
      email: 'kim@example.com',
      password: 'correct horse',
    })
    const response = await fetch(`${origin}/v1/users?${search([Query.select(['email'])])}`, {
      headers: { 'x-appwrite-key': 'a key' },
    })
    const { users } = (await response.json()) as { users: Array<Record<string, unknown>> }
    expect(users.length).toBeGreaterThan(0)
    for (const user of users) {
      expect(Object.keys(user).filter((key) => !key.startsWith('$'))).toEqual(['email'])
    }
  })
})

describe('PATCH /account/email', () => {
  it("refuses another account's address, as Appwrite 1.8 does, and takes a free one", async () => {
    const password = 'correct horse'
    await call('POST', '/account', { userId: 'unique()', email: 'sam@example.com', password })
    await call('POST', '/account', { userId: 'unique()', email: 'alex@example.com', password })
    const { response } = await call('POST', '/account/sessions/email', {
      email: 'sam@example.com',
      password,
    })
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(
      await call('PATCH', '/account/email', { email: 'Alex@example.com', password }, cookie),
    ).toMatchObject({ status: 409, body: { type: 'user_target_already_exists' } })
    expect(
      await call('PATCH', '/account/email', { email: 'sam.new@example.com', password }, cookie),
    ).toMatchObject({ status: 200, body: { email: 'sam.new@example.com' } })
    // Its own address again isn't another account's (AI B on #590).
    expect(
      await call('PATCH', '/account/email', { email: 'sam.new@example.com', password }, cookie),
    ).toMatchObject({ status: 200 })
  })
})

describe('uploads', () => {
  const upload = (bucket: string, cookie: string) => {
    const form = new FormData()
    form.set('fileId', 'unique()')
    form.set('file', new Blob(['%PDF-1.4']), 'receipt.pdf')
    return fetch(`${origin}/v1/storage/buckets/${bucket}/files`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    })
  }

  it('take a receipt from a verified user only, and a statement from no user, as buckets.json says (AI B on #590)', async () => {
    const email = 'lee@example.com'
    const password = 'correct horse'
    const created = await call('POST', '/account', { userId: 'unique()', email, password })
    const { response } = await call('POST', '/account/sessions/email', { email, password })
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect((await upload('receipts', cookie)).status).toBe(401)
    await fetch(`${origin}/v1/users/${created.body.$id}/verification`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-appwrite-key': 'a key' },
      body: JSON.stringify({ emailVerification: true }),
    })
    expect((await upload('receipts', cookie)).status).toBeLessThan(300)
    expect((await upload('statements', cookie)).status).toBe(401)
  })
})
