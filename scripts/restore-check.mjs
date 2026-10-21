// The restore check (docs/engineering/restore.md, #567): after an Appwrite backup is restored, a
// read-only check that the restored database is whole, in Node with built-ins only. The lead runs
// it with a key of rows.read, files.read, users.read and teams.read only, against the restored
// database:
//   node scripts/restore-check.mjs --database-id <id>
// with APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY exported as restore.md shows: the
// key read with read -rs, never typed inline, so it stays out of the shell history.
// It counts each table's rows in <id> beside main's, then lists the groups whose `balances` row
// doesn't match their shares by the nightly check's rule, the final statements whose PDF isn't in
// the `statements` bucket, and, for privacy, the persons and groups whose user or team was
// deleted since the backup: those the account function's hourly passes finish, and those to mark.
// It prints IDs, counts and check names only: never a row's content, a body, a name, an email, the
// endpoint or the key. It exits 0 on PASS, 1 when something is listed to act on (all but those
// finishing), and 2 when a fetch failed or an argument is wrong.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PAGE = 100
// idSchema in packages/core/src/schemas/common.ts: what an Appwrite ID can be. A string only:
// RegExp's test() would read undefined as "undefined".
const isId = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(value)

/**
 * balancesFromShares (packages/core/src/settle/balances.ts): each person's net, given less
 * received, and their count of shares, in ascending personId order. scripts/restore-check.test.mjs
 * checks it against core's.
 */
export function balancesFromShares(shares) {
  const totals = new Map()
  for (const { personId, givenCents, receivedCents } of shares) {
    const total = totals.get(personId) ?? { netCents: 0, shares: 0 }
    totals.set(personId, {
      netCents: total.netCents + (givenCents - receivedCents),
      shares: total.shares + 1,
    })
  }
  return [...totals]
    .map(([personId, total]) => ({ personId, ...total }))
    .sort((a, b) => (a.personId < b.personId ? -1 : 1))
}

/**
 * A `balances` row's peopleJson as readBalances (packages/server/src/ledger/balances.ts) reads it,
 * through balancesPeopleSchema (packages/core/src/schemas/ledger.ts): each entry exactly a valid
 * personId, a safe-integer netCents and shares of at least 1, in ascending personId order, each
 * once. Null when it isn't that, as there.
 */
export function readPeople(peopleJson) {
  let people
  try {
    people = JSON.parse(peopleJson)
  } catch {
    return null
  }
  const valid = (entry, i) =>
    isId(entry?.personId) &&
    Number.isSafeInteger(entry.netCents) &&
    Number.isSafeInteger(entry.shares) &&
    entry.shares >= 1 &&
    Object.keys(entry).length === 3 &&
    (i === 0 || people[i - 1].personId < entry.personId)
  if (!Array.isArray(people) || !people.every(valid)) return null
  return people.map(({ personId, netCents, shares }) => ({ personId, netCents, shares }))
}

/**
 * The nightly check's balances rule (checkGroup in functions/scheduler/src/steps/nightly-check.ts):
 * a group's row as read, against a fresh sum of its shares, compared as JSON. Only for a group
 * that has a row: one with none isn't a finding, as the nightly check builds it.
 */
export function balancesMismatched(peopleJson, shares) {
  return JSON.stringify(readPeople(peopleJson)) !== JSON.stringify(balancesFromShares(shares))
}

class FetchFailed extends Error {}

const unexpected = (what) => new FetchFailed(`FETCH FAILED ${what}: unexpected reply`)

/** Read-only GETs to the Appwrite API, the key in its header only. Never prints a body. */
function getter(endpoint, project, key) {
  return async (what, path, queries) => {
    const url = new URL(endpoint.replace(/\/$/, '') + path)
    for (const query of queries) url.searchParams.append('queries[]', JSON.stringify(query))
    let response
    try {
      // Never followed: a redirect would carry the key, a custom header, to wherever it points.
      response = await fetch(url, {
        headers: { 'X-Appwrite-Project': project, 'X-Appwrite-Key': key },
        redirect: 'manual',
      })
    } catch (error) {
      throw new FetchFailed(`FETCH FAILED ${what}: ${error.cause?.code ?? error.name}`)
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new FetchFailed(`FETCH FAILED ${what}: ${response.status} redirect refused`)
    }
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok) {
      // Appwrite's error type, such as general_unauthorized_scope: never its message.
      const typed = typeof body?.type === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.type)
      throw new FetchFailed(`FETCH FAILED ${what}: ${response.status} ${typed ? body.type : '-'}`)
    }
    if (body === undefined) throw new FetchFailed(`FETCH FAILED ${what}: not JSON`)
    return body
  }
}

/**
 * Each item of a list, 100 a page after the last one's `$id` (scaling.md), until a short page.
 * An item that isn't one with an ID, or one seen before, which would page round for ever, fails.
 */
async function* list(get, what, path, field, filters = []) {
  const seen = new Set()
  let after
  while (true) {
    const cursor = after === undefined ? [] : [{ method: 'cursorAfter', values: [after] }]
    const body = await get(what, path, [...filters, { method: 'limit', values: [PAGE] }, ...cursor])
    const items = body?.[field]
    if (!Array.isArray(items)) throw unexpected(what)
    for (const item of items) {
      if (!isId(item?.$id) || seen.has(item.$id)) throw unexpected(what)
      seen.add(item.$id)
      yield item
    }
    if (items.length < PAGE) return
    after = items.at(-1).$id
  }
}

/** The IDs in a list, and nothing else of its items. */
async function ids(get, what, path, field = 'rows') {
  const found = new Set()
  for await (const item of list(get, what, path, field)) found.add(item.$id)
  return found
}

const rowsPath = (database, table) => `/tablesdb/${database}/tables/${table}/rows`

/** A table's row count, from a list of one row: Appwrite's `total`. */
async function count(get, database, table) {
  const what = `count of ${table} in ${database}`
  const body = await get(what, rowsPath(database, table), [{ method: 'limit', values: [1] }])
  if (!Number.isSafeInteger(body?.total) || body.total < 0) throw unexpected(what)
  return body.total
}

/** The four checks against `database`: the lines to print and how many IDs to act on. */
async function checks(get, database, tables) {
  // 1. Row counts beside main's: information, not pass or fail.
  const databases = database === 'main' ? ['main'] : [database, 'main']
  const cells = [['rows', ...databases]]
  for (const table of tables) {
    const counts = []
    for (const db of databases) counts.push(String(await count(get, db, table)))
    cells.push([table, ...counts])
  }
  const widths = cells[0].map((_, i) => Math.max(...cells.map((row) => row[i].length)))
  const lines = cells.map((row) =>
    row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '),
  )

  // 2. Each group's balances row against its shares (data-model.md#balances). Of each group, only
  // whether its delete has started (deletingAt), for 4.
  const groups = new Map()
  const groupsPath = rowsPath(database, 'groups')
  for await (const row of list(get, `groups in ${database}`, groupsPath, 'rows')) {
    groups.set(row.$id, Boolean(row.deletingAt))
  }
  const shares = new Map()
  const sharesWhat = `shares in ${database}`
  for await (const share of list(get, sharesWhat, rowsPath(database, 'shares'), 'rows')) {
    const { groupId, personId, givenCents, receivedCents } = share
    if (
      typeof groupId !== 'string' ||
      typeof personId !== 'string' ||
      !Number.isSafeInteger(givenCents) ||
      !Number.isSafeInteger(receivedCents)
    ) {
      throw unexpected(sharesWhat)
    }
    if (!shares.has(groupId)) shares.set(groupId, [])
    shares.get(groupId).push({ personId, givenCents, receivedCents })
  }
  const balances = new Map()
  const balancesPath = rowsPath(database, 'balances')
  for await (const row of list(get, `balances in ${database}`, balancesPath, 'rows')) {
    balances.set(row.$id, row.peopleJson ?? null)
  }
  const noRow = [...groups.keys()].filter((groupId) => !balances.has(groupId))
  const mismatched = [...groups.keys()].filter(
    (groupId) =>
      balances.has(groupId) && balancesMismatched(balances.get(groupId), shares.get(groupId) ?? []),
  )
  lines.push(
    `balances · groups ${groups.size} · no row yet ${noRow.length} · mismatched ${mismatched.length}`,
    ...mismatched.map((groupId) => `balances mismatched ${groupId}`),
  )

  // 3. Final statements' PDFs in the statements bucket (data-model.md#statements).
  const finals = []
  const statementsWhat = `statements in ${database}`
  const final = [{ method: 'equal', attribute: 'status', values: ['final'] }]
  const statementsPath = rowsPath(database, 'statements')
  for await (const row of list(get, statementsWhat, statementsPath, 'rows', final)) {
    if (row.status === 'final') finals.push({ statementId: row.$id, pdfFileId: row.pdfFileId })
  }
  const files = await ids(get, 'files in statements', '/storage/buckets/statements/files', 'files')
  // One with no pdfFileId is missing too: finalize sets it before `final` (statements.md, step 7).
  const missing = finals
    .filter(({ pdfFileId }) => !files.has(pdfFileId))
    .map(({ statementId }) => statementId)
  lines.push(
    `statement PDFs · final ${finals.length} · missing ${missing.length}`,
    ...missing.map((statementId) => `missing PDF ${statementId}`),
  )

  // 4. Persons whose user is gone, and groups (row ID = team ID, data-model.md#groups) whose team
  // is. The account function's hourly passes finish a person with deletedAt set and a group with
  // deletingAt set (identity-and-invites.md#finishing-purges); nothing finishes the others, so
  // they're to mark. A profile always names its person, so the persons cover the profiles.
  const persons = []
  const personsPath = rowsPath(database, 'persons')
  const registered = [{ method: 'isNotNull', attribute: 'userId' }]
  for await (const row of list(get, `persons in ${database}`, personsPath, 'rows', registered)) {
    if (typeof row.userId === 'string' && row.userId !== '') {
      persons.push({ id: row.$id, userId: row.userId, finishing: Boolean(row.deletedAt) })
    }
  }
  const users = await ids(get, 'users', '/users', 'users')
  const teams = await ids(get, 'teams', '/teams', 'teams')
  const gone = (what, name, items) => {
    const toMark = items.filter((item) => !item.finishing).map((item) => item.id)
    const finishing = items.filter((item) => item.finishing).map((item) => item.id)
    lines.push(
      `${what} · to mark ${toMark.length} · finishing ${finishing.length}`,
      ...toMark.map((id) => `${name} to mark ${id}`),
      ...finishing.map((id) => `${name} finishing ${id}`),
    )
    return toMark.length
  }
  const personsToMark = gone(
    'persons whose user is gone',
    'person',
    persons.filter((person) => !users.has(person.userId)),
  )
  const groupsToMark = gone(
    'groups whose team is gone',
    'group',
    [...groups]
      .filter(([groupId]) => !teams.has(groupId))
      .map(([groupId, deleting]) => ({ id: groupId, finishing: deleting })),
  )
  return { lines, act: mismatched.length + missing.length + personsToMark + groupsToMark }
}

/** The whole check: the lines to print, and the exit code. */
export async function check(args, env = process.env) {
  const usage = (problem) => ({
    lines: [
      problem,
      'Use: node scripts/restore-check.mjs --database-id <id>, with APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY exported as docs/engineering/restore.md shows (the key by read -rs, never typed inline)',
    ],
    code: 2,
  })
  let values
  try {
    ;({ values } = parseArgs({ args, options: { 'database-id': { type: 'string' } } }))
  } catch {
    // Not parseArgs' message: it repeats the argument, which could be a pasted key.
    return usage('Give --database-id <id>, and nothing else.')
  }
  const database = values['database-id']
  if (!isId(database)) return usage('--database-id is a database ID, such as main.')
  const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = env
  if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
    return usage('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY.')
  }
  // The key goes only over HTTPS; plain HTTP only to this machine, as the tests' stand-in is.
  const endpoint = URL.canParse(APPWRITE_ENDPOINT) ? new URL(APPWRITE_ENDPOINT) : undefined
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint?.hostname ?? '')
  if (endpoint?.protocol !== 'https:' && !(endpoint?.protocol === 'http:' && local)) {
    return usage('APPWRITE_ENDPOINT has to be an https:// URL.')
  }
  const tablesFile = new URL('../appwrite/tables.json', import.meta.url)
  const tables = JSON.parse(readFileSync(tablesFile, 'utf8')).map((table) => table.$id)
  try {
    const get = getter(APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY)
    const { lines, act } = await checks(get, database, tables)
    return {
      lines: [...lines, `restore check ${database}: ${act === 0 ? 'PASS' : `${act} to act on`}`],
      code: act === 0 ? 0 : 1,
    }
  } catch (error) {
    if (error instanceof FetchFailed) return { lines: [error.message], code: 2 }
    throw error
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { lines, code } = await check(process.argv.slice(2))
    console.log(lines.join('\n'))
    process.exit(code)
  } catch (error) {
    // Its name only: a message could carry a row's content, or the endpoint.
    console.error(`restore check: ${error?.name ?? 'error'}`)
    process.exit(2)
  }
}
