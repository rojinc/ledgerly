import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { build } from 'esbuild'
import { balancesFromShares, balancesMismatched, check, readPeople } from './restore-check.mjs'

// Made-up rows, users, teams and files, as the Appwrite API returns them. Some carry a name, an
// email and a phone number, which the check must never print.
const root = join(import.meta.dirname, '..')
const TABLES = JSON.parse(readFileSync(join(root, 'appwrite/tables.json'), 'utf8')).map(
  (t) => t.$id,
)
const KEY = 'test-key-never-printed'
const EMAIL = 'alice.tester@example.com'
const NAME = 'Alice Tester'
const PHONE = '+61400111222'

// Core's own cases (packages/core/src/settle/balances.test.ts): electricity $90, Alice paid, split
// 3 ways; then Bob pays Alice $30. And a refund.
const electricity = [
  { personId: 'cara', givenCents: 0, receivedCents: 3000 },
  { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
  { personId: 'bob', givenCents: 0, receivedCents: 3000 },
]
const payment = [
  { personId: 'bob', givenCents: 3000, receivedCents: 0 },
  { personId: 'alice', givenCents: 0, receivedCents: 3000 },
]
const row = [
  { personId: 'alice', netCents: 3000, shares: 2 },
  { personId: 'bob', netCents: 0, shares: 2 },
  { personId: 'cara', netCents: -3000, shares: 1 },
]
const refund = [
  { personId: 'alice', givenCents: -2000, receivedCents: -1000 },
  { personId: 'bob', givenCents: 0, receivedCents: -1000 },
]
const refundRow = [
  { personId: 'alice', netCents: -1000, shares: 1 },
  { personId: 'bob', netCents: 1000, shares: 1 },
]

let shareIds = 0
/** A group's share rows, from amounts. */
const shares = (groupId, amounts) =>
  amounts.map((amount) => ({
    $id: `sh${String(++shareIds).padStart(5, '0')}`,
    groupId,
    transactionId: 't1',
    date: '2026-10-01',
    kind: 'expense',
    category: null,
    ...amount,
  }))
const balances = (groupId, people) => ({ $id: groupId, peopleJson: JSON.stringify(people) })
const group = (groupId) => ({ $id: groupId, name: `${NAME}'s house`, type: 'house' })

/**
 * A whole project: g1 and g2 with shares and their balances rows, g3 with neither, a final
 * statement with its PDF and a draft with none, a person with a user and a placeholder, and every
 * group's team. The restored database and main hold the same rows.
 */
function whole() {
  const rows = {
    persons: [
      { $id: 'alice', userId: 'u1', displayName: NAME },
      { $id: 'bob', userId: null, displayName: 'Bob' },
    ],
    identities: [{ $id: 'i1', key: EMAIL, type: 'email', personId: 'alice' }],
    profiles: [
      {
        $id: 'u1',
        personId: 'alice',
        businessJson: JSON.stringify({ businessName: NAME, email: EMAIL, phone: PHONE }),
      },
    ],
    groups: [group('g1'), group('g2'), group('g3')],
    shares: [...shares('g1', [...electricity, ...payment]), ...shares('g2', refund)],
    balances: [balances('g1', row), balances('g2', refundRow)],
    statements: [
      {
        $id: 's1',
        groupId: 'g1',
        status: 'final',
        pdfFileId: 's1',
        snapshotJson: `{"to":"${NAME}"}`,
      },
      { $id: 's2', groupId: 'g1', status: 'draft', pdfFileId: null, snapshotJson: '{}' },
    ],
  }
  return {
    databases: { restore1: rows, main: structuredClone(rows) },
    users: [{ $id: 'u1', name: NAME, email: EMAIL, phone: PHONE }],
    teams: [
      { $id: 'g1', name: NAME },
      { $id: 'g2', name: NAME },
      { $id: 'g3', name: NAME },
    ],
    files: [{ $id: 's1', name: 'INV-0001.pdf' }],
  }
}

/**
 * A stand-in for the Appwrite API: rows by database and table, users, teams and the statements
 * bucket's files, as `GET`s, a page after `cursorAfter`. `replies` answers a path with its own
 * status and raw body instead, or only its list pages with `pages: true`, not the count;
 * `ignoreFilters` keeps what an `equal` or `isNotNull` would leave out.
 */
async function serve(data, { replies = {}, ignoreFilters = false } = {}) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const queries = url.searchParams.getAll('queries[]').map((q) => JSON.parse(q))
    requests.push({
      method: request.method,
      url: request.url,
      path: url.pathname,
      headers: request.headers,
      queries,
    })
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    // A check that pages round for ever gets an error, so its test fails rather than hangs.
    if (requests.length > 1000) return reply(500, { type: 'stand_in_overrun' })
    const own = replies[url.pathname]
    if (own && !(own.pages && isCount({ queries }))) return reply(own.status ?? 200, own.body)
    const rows = url.pathname.match(/^\/v1\/tablesdb\/([^/]+)\/tables\/([^/]+)\/rows$/)
    const lists = {
      '/v1/users': ['users', data.users],
      '/v1/teams': ['teams', data.teams],
      '/v1/storage/buckets/statements/files': ['files', data.files],
    }
    const [field, all] = rows
      ? ['rows', data.databases[rows[1]] && (data.databases[rows[1]][rows[2]] ?? [])]
      : (lists[url.pathname] ?? [])
    if (!all) return reply(404, { message: `No ${EMAIL} here`, type: 'database_not_found' })
    const query = (method) => queries.find((q) => q.method === method)
    const equal = query('equal')
    const notNull = query('isNotNull')
    const kept = (item) =>
      ignoreFilters ||
      ((!equal || item[equal.attribute] === equal.values[0]) &&
        (!notNull || (item[notNull.attribute] ?? null) !== null))
    let items = all.filter(kept)
    const after = query('cursorAfter')?.values[0]
    if (after !== undefined) {
      const at = items.findIndex((item) => item.$id === after)
      if (at < 0) return reply(400, { message: 'cursor', type: 'general_cursor_not_found' })
      items = items.slice(at + 1)
    }
    reply(200, {
      total: all.filter(kept).length,
      [field]: items.slice(0, query('limit').values[0]),
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = {
    APPWRITE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/`,
    APPWRITE_PROJECT_ID: 'ledgerly-test',
    APPWRITE_API_KEY: KEY,
  }
  return { env, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** A count's request: a list of one row. */
const isCount = (request) => request.queries.some((q) => q.method === 'limit' && q.values[0] === 1)

/** The check against a stand-in serving `data`: its lines, exit code and the requests it made. */
async function checkAgainst(data, { database = 'restore1', ...options } = {}) {
  const api = await serve(data, options)
  try {
    const result = await check(['--database-id', database], api.env)
    return { ...result, requests: api.requests, env: api.env }
  } finally {
    await api.close()
  }
}

/** The script run as the lead runs it, with `env` and nothing else: exit code, stdout, stderr. */
function script(args, env, nodeOptions = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...nodeOptions, join(root, 'scripts/restore-check.mjs'), ...args],
      { env },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The rows lines for `counts` (table → counts), as the check prints them. */
const rowsLines = (databases, counts) => {
  const cells = [
    ['rows', ...databases],
    ...TABLES.map((t) => [t, ...(counts[t] ?? databases.map(() => 0))]),
  ]
  const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => String(r[i]).length)))
  return cells.map((r) =>
    r
      .map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i])))
      .join('  '),
  )
}

describe('the balances rule', () => {
  it('gives core’s own cases', () => {
    assert.deepEqual(balancesFromShares([...electricity, ...payment]), row)
    assert.deepEqual(balancesFromShares(refund), refundRow)
    assert.deepEqual(balancesFromShares([]), [])
    assert.deepEqual(readPeople(JSON.stringify(row)), row)
    assert.equal(balancesMismatched(JSON.stringify(row), [...electricity, ...payment]), false)
    assert.equal(balancesMismatched(JSON.stringify(refundRow), [...electricity, ...payment]), true)
    assert.equal(balancesMismatched('[]', []), false)
  })

  it('is core’s and the nightly check’s, on many groups', async () => {
    // Core's TypeScript, bundled as the functions are (scripts/build-functions.mjs).
    const { outputFiles } = await build({
      stdin: {
        contents: [
          "export { balancesFromShares } from './packages/core/src/settle/balances.ts'",
          "export { balancesPeopleSchema } from './packages/core/src/schemas/ledger.ts'",
        ].join('\n'),
        resolveDir: root,
        sourcefile: 'core-balances.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      target: 'es2022',
      format: 'esm',
      write: false,
    })
    const core = await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
    )
    // readBalances (packages/server/src/ledger/balances.ts) and `same` in nightly-check.ts.
    const coreRead = (json) => {
      try {
        return core.balancesPeopleSchema.parse(JSON.parse(json))
      } catch {
        return null
      }
    }
    const coreMismatched = (json, amounts) =>
      JSON.stringify(coreRead(json)) !== JSON.stringify(core.balancesFromShares(amounts))

    let state = 7
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const pick = (items) => items[Math.floor(random() * items.length)]
    const outcomes = new Set()
    for (let n = 0; n < 150; n++) {
      const amounts = Array.from({ length: Math.floor(random() * 7) }, () => ({
        personId: pick(['alice', 'bob', 'cara', 'Bob', 'a1', 'a.b', 'a-b', '-x', 'a b']),
        givenCents: pick([0, 0, 9000, 2500, -2000, 1, 2 ** 52]),
        receivedCents: pick([0, 3000, -1000, 1]),
      }))
      const people = core.balancesFromShares(amounts)
      assert.deepEqual(balancesFromShares(amounts), people)
      const json = JSON.stringify(people)
      const first = (change) => JSON.stringify(people.map((p, i) => (i === 0 ? change(p) : p)))
      const each = (change) => JSON.stringify(people.map(change))
      for (const stored of [
        json,
        ` ${json}\n`,
        each(({ personId, netCents, shares }) => ({ shares, netCents, personId })),
        JSON.stringify(people.toReversed()),
        JSON.stringify(people.slice(1)),
        JSON.stringify([...people, ...people.slice(0, 1)]),
        first((p) => ({ ...p, netCents: p.netCents + 1 })),
        first((p) => ({ ...p, shares: p.shares + 1 })),
        first((p) => ({ ...p, note: 'x' })),
        first(({ shares: _, ...p }) => p),
        each((p) => ({ ...p, netCents: String(p.netCents) })),
        each((p) => ({ ...p, netCents: p.netCents + 0.5 })),
        each((p) => ({ ...p, shares: 0 })),
        each((p) => ({ ...p, personId: `.${p.personId}` })),
        json.replace(/"netCents":-?\d+/, '"netCents":9007199254740993'),
        json.replace('"personId"', '"__proto__":1,"personId"'),
        'not json',
        '',
        'null',
        '{}',
        '[]',
        '[null]',
        '[[]]',
        '"[]"',
        null,
      ]) {
        assert.equal(JSON.stringify(readPeople(stored)), JSON.stringify(coreRead(stored)), stored)
        const mismatched = balancesMismatched(stored, amounts)
        assert.equal(mismatched, coreMismatched(stored, amounts), stored)
        outcomes.add(mismatched)
      }
    }
    assert.deepEqual([...outcomes].sort(), [false, true])
  })
})

describe('the check', () => {
  const counts = {
    persons: [2, 2],
    identities: [1, 1],
    profiles: [1, 1],
    groups: [3, 3],
    shares: [7, 7],
    balances: [2, 2],
    statements: [2, 2],
  }

  it('passes a whole restore, its rows beside main’s, and exits 0', async () => {
    const { lines, code } = await checkAgainst(whole())
    assert.deepEqual(lines, [
      ...rowsLines(['restore1', 'main'], counts),
      'balances · groups 3 · no row yet 1 · mismatched 0',
      'statement PDFs · final 1 · missing 0',
      'persons whose user is gone · to mark 0 · finishing 0',
      'groups whose team is gone · to mark 0 · finishing 0',
      'restore check restore1: PASS',
    ])
    assert.equal(lines[0], 'rows           restore1  main')
    assert.equal(lines[7], 'shares                7     7')
    assert.equal(code, 0)
  })

  it('counts every table in appwrite/tables.json, in its order', async () => {
    assert.equal(TABLES.length, 17)
    const data = whole()
    data.databases.main.persons.push({ $id: 'carl', displayName: 'Carl' })
    const { lines, requests } = await checkAgainst(data)
    assert.deepEqual(
      lines.slice(1, 18).map((line) => line.split(/ +/)[0]),
      TABLES,
    )
    assert.equal(lines[1], 'persons               2     3')
    for (const db of ['restore1', 'main']) {
      for (const table of TABLES) {
        const path = `/v1/tablesdb/${db}/tables/${table}/rows`
        const count = requests.find((r) => r.path === path)
        assert.deepEqual(count.queries, [{ method: 'limit', values: [1] }])
      }
    }
  })

  it('checks main alone in one column', async () => {
    const data = whole()
    delete data.databases.restore1
    const { lines, code, requests } = await checkAgainst(data, { database: 'main' })
    assert.deepEqual(lines, [
      ...rowsLines(
        ['main'],
        Object.fromEntries(Object.entries(counts).map(([t, [, n]]) => [t, [n]])),
      ),
      'balances · groups 3 · no row yet 1 · mismatched 0',
      'statement PDFs · final 1 · missing 0',
      'persons whose user is gone · to mark 0 · finishing 0',
      'groups whose team is gone · to mark 0 · finishing 0',
      'restore check main: PASS',
    ])
    assert.equal(lines[0], 'rows           main')
    assert.equal(code, 0)
    // Each table counted once.
    const countsOf = requests.filter(isCount)
    assert.equal(countsOf.length, 17)
  })

  it('lists a group whose balances row doesn’t match its shares, but not one with no row', async () => {
    const data = whole()
    const rows = data.databases.restore1
    rows.groups.push(group('g4'), group('g5'), group('g6'))
    data.teams.push({ $id: 'g4' }, { $id: 'g5' }, { $id: 'g6' })
    rows.balances = [
      balances('g1', [{ ...row[0], netCents: 3001 }, ...row.slice(1)]),
      { $id: 'g2', peopleJson: 'not json' },
      balances('g4', []),
      balances('g5', refundRow),
      // Shares of g6 in the wrong order: not the row readBalances reads.
      balances('g6', refundRow.toReversed()),
    ]
    rows.shares.push(...shares('g6', refund))
    const { lines, code } = await checkAgainst(data)
    assert.deepEqual(lines.slice(18), [
      'balances · groups 6 · no row yet 1 · mismatched 4',
      'balances mismatched g1',
      'balances mismatched g2',
      'balances mismatched g5',
      'balances mismatched g6',
      'statement PDFs · final 1 · missing 0',
      'persons whose user is gone · to mark 0 · finishing 0',
      'groups whose team is gone · to mark 0 · finishing 0',
      'restore check restore1: 4 to act on',
    ])
    assert.equal(code, 1)
  })

  it('lists a final statement whose PDF isn’t in the bucket, and no other', async () => {
    const data = whole()
    data.databases.restore1.statements.push(
      { $id: 's3', status: 'final', pdfFileId: 's3' },
      { $id: 's4', status: 'final', pdfFileId: null },
      { $id: 's5', status: 'finalizing', pdfFileId: null },
      { $id: 's6', status: 'void', pdfFileId: 's6' },
    )
    data.files.push({ $id: 's9' })
    for (const ignoreFilters of [false, true]) {
      const { lines, code, requests } = await checkAgainst(data, { ignoreFilters })
      assert.deepEqual(lines.slice(19, 22), [
        'statement PDFs · final 3 · missing 2',
        'missing PDF s3',
        'missing PDF s4',
      ])
      assert.equal(lines.at(-1), 'restore check restore1: 2 to act on')
      assert.equal(code, 1)
      const listed = requests.find(
        (r) => r.path === '/v1/tablesdb/restore1/tables/statements/rows' && r.queries.length > 1,
      )
      assert.deepEqual(listed.queries[0], {
        method: 'equal',
        attribute: 'status',
        values: ['final'],
      })
    }
  })

  it('lists the persons and groups a deletion since the backup left: to mark, or finishing', async () => {
    const data = whole()
    const rows = data.databases.restore1
    const deletedAt = '2026-10-20T01:00:00.000+00:00'
    rows.persons.push(
      { $id: 'p2', userId: 'u2', deletedAt: null, displayName: NAME },
      { $id: 'p3', userId: 'u3', deletedAt, displayName: 'Former member' },
      // A deletion under way whose user is still there, and placeholders: none listed.
      { $id: 'p4', userId: 'u4', deletedAt, displayName: 'Former member' },
      { $id: 'p5', userId: null, displayName: 'Placeholder' },
      { $id: 'p6', userId: '', displayName: 'Placeholder' },
    )
    data.users.push({ $id: 'u4', email: EMAIL })
    rows.groups.push(group('g4'), { ...group('g5'), deletingAt: deletedAt })
    data.teams = data.teams.filter((team) => team.$id !== 'g2')
    for (const ignoreFilters of [false, true]) {
      const { lines, code, requests } = await checkAgainst(data, { ignoreFilters })
      assert.deepEqual(lines.slice(18), [
        'balances · groups 5 · no row yet 3 · mismatched 0',
        'statement PDFs · final 1 · missing 0',
        'persons whose user is gone · to mark 1 · finishing 1',
        'person to mark p2',
        'person finishing p3',
        'groups whose team is gone · to mark 2 · finishing 1',
        'group to mark g2',
        'group to mark g4',
        'group finishing g5',
        'restore check restore1: 3 to act on',
      ])
      assert.equal(code, 1)
      const listed = requests.find(
        (r) => r.path === '/v1/tablesdb/restore1/tables/persons/rows' && r.queries.length > 1,
      )
      assert.deepEqual(listed.queries[0], { method: 'isNotNull', attribute: 'userId' })
    }
  })

  it('passes when every person and group a deletion left is finishing', async () => {
    const data = whole()
    const deletedAt = '2026-10-20T01:00:00.000+00:00'
    data.databases.restore1.persons.push({ $id: 'p3', userId: 'u3', deletedAt })
    data.databases.restore1.groups.push({ ...group('g5'), deletingAt: deletedAt })
    const { lines, code } = await checkAgainst(data)
    assert.deepEqual(lines.slice(20), [
      'persons whose user is gone · to mark 0 · finishing 1',
      'person finishing p3',
      'groups whose team is gone · to mark 0 · finishing 1',
      'group finishing g5',
      'restore check restore1: PASS',
    ])
    assert.equal(code, 0)
  })

  it('pages 100 at a time after the last ID, through rows, users, teams and files', async () => {
    const data = whole()
    const rows = data.databases.restore1
    const many = (n, make) => Array.from({ length: n }, (_, i) => make(String(i).padStart(3, '0')))
    // 230 shares in g1, its row summed from all of them: a page left out would be a mismatch.
    const amounts = many(230, (i) => ({
      personId: `p${Number(i) % 7}`,
      givenCents: Number(i),
      receivedCents: 3,
    }))
    rows.shares = shares('g1', amounts)
    rows.balances = [balances('g1', balancesFromShares(amounts))]
    rows.groups = many(120, (i) => group(`g${i}`)).concat(group('g1'))
    rows.persons = many(150, (i) => ({ $id: `p${i}`, userId: `u${i}`, displayName: NAME }))
    rows.statements = many(100, (i) => ({ $id: `s${i}`, status: 'final', pdfFileId: `f${i}` }))
    data.users = many(230, (i) => ({ $id: `u${i}`, name: NAME, email: EMAIL, phone: PHONE }))
    data.teams = rows.groups.map(({ $id }) => ({ $id, name: NAME }))
    data.files = many(100, (i) => ({ $id: `f${i}`, name: 'a.pdf' }))
    const { lines, code, requests } = await checkAgainst(data)
    assert.deepEqual(lines.slice(18), [
      'balances · groups 121 · no row yet 120 · mismatched 0',
      'statement PDFs · final 100 · missing 0',
      'persons whose user is gone · to mark 0 · finishing 0',
      'groups whose team is gone · to mark 0 · finishing 0',
      'restore check restore1: PASS',
    ])
    assert.equal(code, 0)
    const pages = (path) => requests.filter((r) => r.path === path && !isCount(r))
    const cursors = (path) =>
      pages(path).map((r) => r.queries.find((q) => q.method === 'cursorAfter')?.values[0] ?? '-')
    assert.deepEqual(cursors('/v1/tablesdb/restore1/tables/shares/rows'), [
      '-',
      rows.shares[99].$id,
      rows.shares[199].$id,
    ])
    assert.deepEqual(cursors('/v1/users'), ['-', 'u099', 'u199'])
    assert.deepEqual(cursors('/v1/tablesdb/restore1/tables/persons/rows'), ['-', 'p099'])
    assert.deepEqual(cursors('/v1/teams'), ['-', 'g099'])
    // Exactly 100: a second, empty page ends it.
    assert.deepEqual(cursors('/v1/storage/buckets/statements/files'), ['-', 'f099'])
    assert.ok(
      requests.every((r) =>
        r.queries.some((q) => q.method === 'limit' && [1, 100].includes(q.values[0])),
      ),
    )
  })

  it('stops, rather than pages round for ever, when a page comes again', async () => {
    const users = Array.from({ length: 100 }, (_, i) => ({ $id: `u${i}`, email: EMAIL }))
    const { lines, code } = await checkAgainst(whole(), {
      replies: { '/v1/users': { body: { total: 100, users } } },
    })
    assert.deepEqual([lines, code], [['FETCH FAILED users: unexpected reply'], 2])
  })
})

describe('fetching', () => {
  it('sends GETs only, with the key in its header and never in a URL', async () => {
    const { requests } = await checkAgainst(whole())
    assert.ok(requests.length > 40)
    for (const request of requests) {
      assert.equal(request.method, 'GET')
      assert.equal(request.headers['x-appwrite-key'], KEY)
      assert.equal(request.headers['x-appwrite-project'], 'ledgerly-test')
      assert.ok(!request.url.includes(KEY))
      assert.ok(!decodeURIComponent(request.url).includes(KEY))
    }
  })

  it('never follows a redirect, so the key never reaches another host', async () => {
    const elsewhere = []
    const other = createServer((request, response) => {
      elsewhere.push(request.headers)
      response.end('{"total":0,"rows":[]}')
    })
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
    const redirect = createServer((request, response) => {
      response.writeHead(301, {
        location: `http://127.0.0.1:${other.address().port}${request.url}`,
      })
      response.end()
    })
    await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve))
    try {
      const env = {
        APPWRITE_ENDPOINT: `http://127.0.0.1:${redirect.address().port}/v1`,
        APPWRITE_PROJECT_ID: 'ledgerly-test',
        APPWRITE_API_KEY: KEY,
      }
      assert.deepEqual(await check(['--database-id', 'restore1'], env), {
        lines: ['FETCH FAILED count of persons in restore1: 301 redirect refused'],
        code: 2,
      })
      assert.deepEqual(elsewhere, [])
    } finally {
      await new Promise((resolve) => redirect.close(resolve))
      await new Promise((resolve) => other.close(resolve))
    }
  })

  it('sends the key only over HTTPS, or plain HTTP to this machine’s exact name', async () => {
    for (const endpoint of [
      'http://cloud.example/v1',
      'http://localhost.example/v1',
      'http://127.0.0.1.example/v1',
      'http://localhost./v1',
      'ftp://localhost/v1',
      'not a url',
    ]) {
      const env = { APPWRITE_ENDPOINT: endpoint, APPWRITE_PROJECT_ID: 'p', APPWRITE_API_KEY: KEY }
      const result = await check(['--database-id', 'restore1'], env)
      assert.deepEqual(
        [result.code, result.lines[0]],
        [2, 'APPWRITE_ENDPOINT has to be an https:// URL.'],
        endpoint,
      )
    }
  })

  it('stops with FETCH FAILED, never the body, on a reply that isn’t JSON or isn’t a list', async () => {
    const persons = '/v1/tablesdb/restore1/tables/persons/rows'
    const groups = '/v1/tablesdb/restore1/tables/groups/rows'
    const sharesPath = '/v1/tablesdb/restore1/tables/shares/rows'
    for (const [path, body, line] of [
      [persons, `<p>${EMAIL}</p>`, 'FETCH FAILED count of persons in restore1: not JSON'],
      [persons, '', 'FETCH FAILED count of persons in restore1: not JSON'],
      [persons, 'null', 'FETCH FAILED count of persons in restore1: unexpected reply'],
      [persons, '{"total":"2"}', 'FETCH FAILED count of persons in restore1: unexpected reply'],
      [persons, '{"total":-1}', 'FETCH FAILED count of persons in restore1: unexpected reply'],
      [groups, 'null', 'FETCH FAILED groups in restore1: unexpected reply'],
      [groups, '{"total":1,"rows":null}', 'FETCH FAILED groups in restore1: unexpected reply'],
      [groups, '{"total":1}', 'FETCH FAILED groups in restore1: unexpected reply'],
      [
        groups,
        `{"rows":[{"name":"${NAME}"}]}`,
        'FETCH FAILED groups in restore1: unexpected reply',
      ],
      [groups, '{"rows":[null]}', 'FETCH FAILED groups in restore1: unexpected reply'],
      [
        groups,
        `{"rows":[{"$id":"${EMAIL}"}]}`,
        'FETCH FAILED groups in restore1: unexpected reply',
      ],
      [
        sharesPath,
        '{"rows":[{"$id":"x","groupId":"g1","personId":"a","givenCents":1.5,"receivedCents":0}]}',
        'FETCH FAILED shares in restore1: unexpected reply',
      ],
      [
        sharesPath,
        '{"rows":[{"$id":"x","groupId":"g1","personId":"a","givenCents":"100","receivedCents":0}]}',
        'FETCH FAILED shares in restore1: unexpected reply',
      ],
    ]) {
      // The count's reply, or only the list's pages.
      const pages = !line.startsWith('FETCH FAILED count of')
      const result = await checkAgainst(whole(), { replies: { [path]: { body, pages } } })
      assert.deepEqual([result.lines, result.code], [[line], 2], body)
    }
  })

  it('stops with FETCH FAILED and the error’s type, never its message', async () => {
    const message = {
      message: `${NAME} ${EMAIL} secret detail`,
      type: 'general_unauthorized_scope',
    }
    const users = await checkAgainst(whole(), {
      replies: { '/v1/users': { status: 401, body: message } },
    })
    assert.deepEqual(
      [users.lines, users.code],
      [['FETCH FAILED users: 401 general_unauthorized_scope'], 2],
    )
    // A type that isn't one, or a body that isn't JSON: no type at all.
    for (const body of [{ type: EMAIL }, `${EMAIL}`, { type: 7 }]) {
      const teams = await checkAgainst(whole(), { replies: { '/v1/teams': { status: 500, body } } })
      assert.deepEqual(teams.lines, ['FETCH FAILED teams: 500 -'])
    }
    const gone = await checkAgainst(whole(), { database: 'restore9' })
    assert.deepEqual(gone.lines, [
      'FETCH FAILED count of persons in restore9: 404 database_not_found',
    ])
  })
})

describe('the command', () => {
  const usage =
    'Use: node scripts/restore-check.mjs --database-id <id>, with APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY exported as docs/engineering/restore.md shows (the key by read -rs, never typed inline)'
  const env = {
    APPWRITE_ENDPOINT: 'https://cloud.example/v1',
    APPWRITE_PROJECT_ID: 'p',
    APPWRITE_API_KEY: KEY,
  }

  it('gives the usage line, and exits 2, on a wrong argument', async () => {
    for (const [args, problem] of [
      [['--database-id', 'restore1', '--verbose'], 'Give --database-id <id>, and nothing else.'],
      [
        ['--database-id', 'restore1', 'pasted-secret-value'],
        'Give --database-id <id>, and nothing else.',
      ],
      [['--key=pasted-secret-value'], 'Give --database-id <id>, and nothing else.'],
      [['--database-id'], 'Give --database-id <id>, and nothing else.'],
      [[], '--database-id is a database ID, such as main.'],
      [['--database-id', ''], '--database-id is a database ID, such as main.'],
      [['--database-id', '../main'], '--database-id is a database ID, such as main.'],
      [['--database-id', 'main/tables'], '--database-id is a database ID, such as main.'],
    ]) {
      assert.deepEqual(await check(args, env), { lines: [problem, usage], code: 2 }, args.join(' '))
    }
  })

  it('gives the usage line, and exits 2, when a setting is missing', async () => {
    for (const name of Object.keys(env)) {
      const { [name]: _, ...rest } = env
      assert.deepEqual(await check(['--database-id', 'restore1'], rest), {
        lines: ['Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY.', usage],
        code: 2,
      })
    }
  })

  it('never prints a name, an email, a phone, a body, the endpoint or the key', async () => {
    const failing = whole()
    const rows = failing.databases.restore1
    rows.profiles.push({ $id: 'u2', businessJson: `{"email":"${EMAIL}","phone":"${PHONE}"}` })
    rows.persons.push({ $id: 'p2', userId: 'u2', displayName: NAME })
    rows.groups.push({ $id: 'g4', name: NAME })
    rows.balances[0].peopleJson = `[{"personId":"${EMAIL}","netCents":1,"shares":1}]`
    rows.statements.push({ $id: 's3', status: 'final', pdfFileId: 's3', snapshotJson: EMAIL })
    const runs = []
    const run = async (data, options, nodeOptions) => {
      const api = await serve(data, options)
      try {
        const out = await script(['--database-id', 'restore1'], api.env, nodeOptions)
        runs.push({ ...out, host: new URL(api.env.APPWRITE_ENDPOINT).host })
        return out
      } finally {
        await api.close()
      }
    }
    assert.equal((await run(whole())).code, 0)
    const failed = await run(failing)
    assert.equal(failed.code, 1)
    assert.match(failed.stdout, /\nrestore check restore1: 4 to act on\n$/)
    // Every line one of the check's own: a count, a check's counts, or a line with an ID.
    for (const line of failed.stdout.trimEnd().split('\n')) {
      assert.match(
        line,
        /^(rows +restore1 +main|\w+ +\d+ +\d+|(balances|statement PDFs|persons whose user is gone|groups whose team is gone) · .*|(balances mismatched|missing PDF|(person|group) (to mark|finishing)) [\w.-]+|restore check restore1: .*)$/,
      )
    }
    const message = {
      body: { message: `${NAME} ${EMAIL} ${PHONE}`, type: 'user_unauthorized' },
      status: 401,
    }
    assert.equal((await run(whole(), { replies: { '/v1/users': message } })).code, 2)
    const html = { body: `<p>${NAME} ${EMAIL}</p>` }
    assert.equal((await run(whole(), { replies: { '/v1/teams': html } })).code, 2)
    // Any other error: its name only, on stderr, and exit 2.
    const thrown = `data:text/javascript,URL.canParse=()=>{throw new RangeError("${EMAIL}")}`
    const other = await run(whole(), {}, ['--import', thrown])
    assert.deepEqual(other, { code: 2, stdout: '', stderr: 'restore check: RangeError\n' })
    for (const { stdout, stderr, host } of runs) {
      for (const secret of [NAME, 'Alice', EMAIL, PHONE, KEY, host, 'secret', '<p>']) {
        assert.ok(!stdout.includes(secret) && !stderr.includes(secret), secret)
      }
    }
  })
})
