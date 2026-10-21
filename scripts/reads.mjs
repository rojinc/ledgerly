// One read of the nightly check and the error lines (docs/engineering/nightly-check.md and
// error-lines.md, #553): the runbooks' checks, in Node with built-ins only, ending in the two lines
// to post on #299. The lead runs it at each read, with the runs and groups the runbooks fetch:
//   node scripts/reads.mjs --from <the last result's "to"> --to <the blocks' "$TO"> \
//     --runs <file> --groups <file>
// or fetching them itself, read-only, with the read key, typed so it stays out of the shell history:
//   read -rs APPWRITE_API_KEY && export APPWRITE_API_KEY
//   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… node scripts/reads.mjs --from … --fetch
//   unset APPWRITE_API_KEY
// It prints IDs, counts, times, event and error names only: never a raw line, a body, a name or the
// key. It exits 0 on PASS and OK, 1 when there's something to post on #96, and 2 when there's
// nothing to post yet (too early, a fetch that failed, a reply or file it can't read, or a wrong
// argument).
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const FUNCTIONS = ['scheduler', 'statements', 'account', 'identity', 'groups', 'ledger']

// LEVELS in packages/server/src/http/log.ts (log and warn), and the nightly check's B events: the
// error read skips them (error-lines.md). scripts/reads.test.mjs checks this list against LEVELS.
export const SKIPPED = [
  'typed_keys_deleted',
  'merge_typed_keys_deleted',
  'merge_finished',
  'merge_carries_on',
  'merge_stopped_into_deleted',
  'merge_run',
  'claim_identity_unusable',
  'nightly_check_cut_off',
  'pdf_characters_replaced',
  'merge_left_transaction',
  'merge_left_locked_transaction',
  'merge_left_schedule',
  'merge_left_stray_row',
  'merge_left_subjects',
  'merge_put_off_team_gone',
  'merge_left_inputs',
  'merge_stopped',
  'merge_walk_cut_off',
  'receipt_cleanup_behind',
  'receipt_cleanup_tied',
  'transaction_changes_skipped',
  'invoice_business_dropped',
  'nightly_check_finding',
  'nightly_check_failed',
  'team_membership_removed',
]

const NIGHTLY_EVENTS = [
  'nightly_check_finding',
  'nightly_check_failed',
  'nightly_check_cut_off',
  'team_membership_removed',
]
const ID_FIELDS = [
  'groupId',
  'statementId',
  'transactionId',
  'personId',
  'intoPersonId',
  'userId',
  'profileId',
  'scheduleId',
  'reminderId',
  'membershipId',
  'rowId',
]

// jq's rules, which the runbooks' blocks follow, so both give the same lines: only null and false
// are false, `a // b` is b only then, and a value in a string is itself if text, else its JSON.
const truthy = (value) => value !== null && value !== undefined && value !== false
const or = (value, fallback) => (truthy(value) ? value : fallback)
const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))

/** jq's order: null, false, true, numbers, strings, arrays, objects. */
function compare(a, b) {
  const rank = (v) =>
    v === null || v === undefined
      ? 0
      : v === false
        ? 1
        : v === true
          ? 2
          : typeof v === 'number'
            ? 3
            : typeof v === 'string'
              ? 4
              : Array.isArray(v)
                ? 5
                : 6
  const [x, y] = [rank(a), rank(b)]
  if (x !== y) return x - y
  if (x === 3) return a - b
  if (x === 4) return a < b ? -1 : a > b ? 1 : 0
  if (x === 5) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = compare(a[i], b[i])
      if (order !== 0) return order
    }
    return a.length - b.length
  }
  if (x === 6) return compare(JSON.stringify(a), JSON.stringify(b))
  return 0
}

/** jq's group_by: groups in key order, each in input order. */
function groupBy(items, key) {
  const sorted = items
    .map((item) => ({ item, key: key(item) }))
    .sort((a, b) => compare(a.key, b.key))
  const groups = []
  for (const { item, key: k } of sorted) {
    const last = groups.at(-1)
    if (last && compare(last.key, k) === 0) last.items.push(item)
    else groups.push({ key: k, items: [item] })
  }
  return groups.map((group) => group.items)
}

const uniqueById = (runs) => groupBy(runs, (run) => run.$id).map((group) => group[0])
const max = (values) =>
  values.reduce((a, b) => (a === undefined || compare(b, a) >= 0 ? b : a), undefined)
const min = (values) =>
  values.reduce((a, b) => (a === undefined || compare(b, a) < 0 ? b : a), undefined)

const at = (run) => `${run.$createdAt.slice(0, 19)}Z`
const seconds = (time) => Date.parse(time) / 1000
/** A time as jq's `todate` writes it, to the second. */
export const todate = (secs) =>
  new Date(Math.floor(secs) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** A run's log lines, its errors first: each line that's a JSON object. */
function lines(run) {
  return `${or(run.errors, '')}\n${or(run.logs, '')}`.split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? [value] : []
    } catch {
      return []
    }
  })
}

const inWindow = (from, to) => (run) => at(run) >= from && at(run) < to
const scheduled = (runs) =>
  runs.filter((run) => run.fn === 'scheduler' && run.trigger === 'schedule')

/** The nightly check's A: the scheduler's scheduled runs. */
export function nightlyA(runs, from, to) {
  const all = uniqueById(scheduled(runs))
  const before = or(max(all.filter((run) => at(run) < from).map(at)), from)
  const window = all.filter(inWindow(from, to)).sort((a, b) => compare(at(a), at(b)))
  const times = [before, ...window.map(at), to].map(seconds)
  const gaps = times.slice(1).map((time, i) => time - times[i])
  const notOk = window.filter((run) => run.status !== 'completed' || run.responseStatusCode !== 200)
  const hours = Math.floor((seconds(to) - seconds(from)) / 360) / 10
  const longestRun = Math.floor(or(max(window.map((run) => or(run.duration, 0))), 0))
  return [
    `window ${hours} h · runs ${window.length} · not ok ${notOk.length} · longest gap ${Math.floor(max(gaps) / 60)} min · longest run ${longestRun} s`,
    ...notOk.map(
      (run) =>
        `not ok ${text(run.$id)} ${at(run)} ${text(run.status)} ${text(or(run.responseStatusCode, '-'))}`,
    ),
  ]
}

/** The nightly check's B: the lines of the same runs. */
export function nightlyB(runs, from, to) {
  const window = uniqueById(scheduled(runs)).filter(inWindow(from, to))
  const events = window.flatMap((run) =>
    lines(run)
      .filter((line) => NIGHTLY_EVENTS.includes(line.event))
      .map((line) => ({ ...line, at: at(run) })),
  )
  const count = (event) => events.filter((line) => line.event === event).length
  const logged = window.filter((run) => lines(run).some((line) => truthy(line.route))).length
  return [
    `logged ${logged} of ${window.length} runs · findings ${count('nightly_check_finding')} · failed ${count('nightly_check_failed')} · cut off ${count('nightly_check_cut_off')} · removed ${count('team_membership_removed')}`,
    ...events.map(
      (line) =>
        `${line.at} ${text(line.event)} ${text(or(line.groupId, '-'))} ${text(or(line.rule, '-'))} ${text(or(or(or(line.transactionId, line.membershipId), line.cause), '-'))}`,
    ),
  ]
}

/** The nightly check's C: groups still due 2 hours after their time, as at `stale`. */
export function nightlyC(groups, stale) {
  const line = (group, due) =>
    `overdue ${text(group.$id)} due ${due} deleting ${text(or(group.deletingAt, '-'))} archived ${text(or(group.archivedAt, '-'))}`
  const hasTime = (group) => group.nextCheckAt !== null && group.nextCheckAt !== undefined
  return [
    ...groups
      .filter((group) => hasTime(group) && Date.parse(group.nextCheckAt) < Date.parse(stale))
      .map((group) => line(group, text(group.nextCheckAt))),
    ...groups
      .filter((group) => !hasTime(group) && `${group.$createdAt.slice(0, 19)}Z` < stale)
      .map((group) => line(group, 'never')),
  ]
}

/**
 * The nightly check's result line (nightly-check.md#the-result) from A's, B's and C's lines, and
 * then the lines to post on #96. `pending` is the last read's pending group IDs. `tooEarly` says a
 * run hadn't finished, so there's nothing to post yet. `c` is null when C wasn't read: the line
 * then says `overdue not read`, and the verdict is A's and B's.
 */
export function nightlyResult(a, b, c, { from, to, pending = [] }) {
  const counts = (line, re) =>
    Object.fromEntries(Object.entries(line.match(re).groups).map(([k, v]) => [k, Number(v)]))
  const A = counts(
    a[0],
    /runs (?<runs>\d+) · not ok (?<notok>\d+) · longest gap (?<gap>\d+) min · longest run (?<run>\d+) s/,
  )
  const B = counts(
    b[0],
    /logged (?<logged>\d+) of (?<runs>\d+) runs · findings (?<findings>\d+) · failed (?<failed>\d+) · cut off (?<cut>\d+) · removed (?<removed>\d+)/,
  )
  // A group is pending while a purge deletes it, or once archived, but not at two reads in a row.
  const overdue = (c ?? []).map((line) => {
    const { id, deleting, archived } = line.match(
      /^overdue (?<id>\S+) due \S+ deleting (?<deleting>\S+) archived (?<archived>\S+)$/,
    ).groups
    const again = pending.includes(id)
    return { id, line, again, pending: !again && (deleting !== '-' || archived !== '-') }
  })
  const pass =
    A.notok === 0 &&
    A.gap <= 125 &&
    B.logged === B.runs &&
    B.findings === 0 &&
    B.failed === 0 &&
    B.cut === 0 &&
    overdue.every((group) => group.pending)
  const pendingIds = overdue.filter((group) => group.pending).map((group) => group.id)
  return {
    tooEarly: a.slice(1).some((line) => /^not ok \S+ \S+ (waiting|processing) /.test(line)),
    pass,
    line: `${from} → ${to} · runs ${A.runs}, not ok ${A.notok}, longest gap ${A.gap} min, longest run ${A.run} s · logged ${B.logged} of ${B.runs} · findings ${B.findings} · failed ${B.failed} · cut off ${B.cut} · removed ${B.removed} · ${c === null ? 'overdue not read' : `overdue ${overdue.length} · pending ${pendingIds.length > 0 ? pendingIds.join(', ') : 'none'}`} · ${pass ? 'PASS' : 'FAIL'}`,
    notes: [
      ...a.slice(1),
      ...b.slice(1),
      ...overdue
        .filter((group) => !group.pending)
        .map((group) => group.line + (group.again ? ' · pending at the last read too' : '')),
      ...(A.run >= 700 ? [`longest run ${A.run} s: post it on #96 if it repeats`] : []),
    ],
  }
}

/** The error lines' read (error-lines.md#a-read): every function's runs. */
export function errorLines(runs, { from, to, capped = '', failed = '' }) {
  const failure = (line, run) => {
    if ('route' in line)
      return or(line.status, 0) >= 500 || (run.trigger !== 'http' && line.status !== 200)
    if (line.event === 'password_notice' || line.event === 'change_notice')
      return line.outcome === 'failed'
    if ('event' in line) return !SKIPPED.includes(line.event)
    return false
  }
  const blocked = (line) =>
    /^EmailError ([a-z_]+ (401|403)|invalid_api_key)/.test(or(line.cause, ''))
  const ids = (line) =>
    ID_FIELDS.filter((field) => truthy(line[field]))
      .map((field) => `${field} ${text(line[field])}`)
      .join(' ')
  const code = (run) => or(run.responseStatusCode, 0)
  const notOk = (run) =>
    run.trigger === 'http'
      ? code(run) >= 500 || code(run) < 200
      : run.status !== 'completed' || code(run) !== 200
  const all = uniqueById(runs)
  const gap = (fn) => {
    const own = all.filter((run) => run.fn === fn && run.trigger === 'schedule')
    const before = or(max(own.filter((run) => at(run) < from).map(at)), from)
    const window = own.filter(inWindow(from, to)).map(at).sort(compare)
    const times = [before, ...window, to].map(seconds)
    return Math.floor(max(times.slice(1).map((time, i) => time - times[i])) / 60)
  }
  const gaps = FUNCTIONS.slice(0, 4).map((fn) => ({ fn, gap: gap(fn) }))
  const window = all.filter(inWindow(from, to))
  const done = window.filter((run) => !notOk(run))
  const failing = window.flatMap((run) =>
    lines(run)
      .filter((line) => failure(line, run))
      .map((line) => ({ ...line, run: run.$id, at: at(run) })),
  )
  const groups = groupBy(
    failing.filter((line) => !blocked(line)),
    (line) => [line.fn ?? null, or(line.event, line.route) ?? null, or(line.cause, '-'), ids(line)],
  )
  const runCount = (group) => new Set(group.map((line) => line.run)).size
  const repeating = groups.filter((group) => runCount(group) >= 3)
  const notOkRuns = window.filter(notOk)
  const notOkRepeating = groupBy(
    notOkRuns.filter(
      (run) => run.trigger === 'schedule' && !lines(run).some((line) => 'route' in line),
    ),
    (run) => run.fn ?? null,
  ).filter((group) => group.length >= 3)
  // jq's max_by: the last of those with the longest gap.
  const worst = gaps.reduce((a, b) => (b.gap >= a.gap ? b : a))
  const identityRuns = window.filter((run) => run.fn === 'identity' && run.trigger === 'schedule')
  const carried = groupBy(
    identityRuns.flatMap((run) =>
      lines(run)
        .filter((line) => line.event === 'merge_carries_on')
        .map((line) => ({ ...line, run: run.$id })),
    ),
    (line) => [or(line.personId, '-'), or(line.intoPersonId, '-')],
  )
  const logged = done.filter((run) => lines(run).some((line) => 'route' in line)).length
  const verdict =
    failed !== ''
      ? 'FETCH FAILED'
      : window.some((run) => run.status === 'waiting' || run.status === 'processing')
        ? 'TOO EARLY'
        : repeating.length > 0 || notOkRepeating.length > 0 || worst.gap > 125
          ? 'STUCK'
          : capped !== '' || logged < done.length
            ? 'INCOMPLETE'
            : groups.length > 0 || notOkRuns.length > 0
              ? 'LOOK'
              : 'OK'
  const perFunction = FUNCTIONS.map(
    (fn) => `${fn} ${window.filter((run) => run.fn === fn).length}`,
  ).join(', ')
  const errorCount = groups.reduce((sum, group) => sum + group.length, 0)
  return {
    verdict,
    line: `errors ${from} → ${to} · runs ${perFunction} · not ok ${notOkRuns.length} · longest gap ${worst.gap} min (${worst.fn}) · logged ${logged} of ${done.length} · error lines ${errorCount} in ${groups.length} groups · repeating ${repeating.length + notOkRepeating.length} · email blocked ${failing.filter(blocked).length} · merges carried on ${carried.length} · ${verdict}`,
    notes: [
      ...notOkRuns.map(
        (run) =>
          `not ok ${text(run.fn)} ${text(run.$id)} ${at(run)} ${text(run.trigger)} ${text(run.status)} ${text(or(run.responseStatusCode, '-'))}`,
      ),
      ...groups.map((group) => {
        const first = group[0]
        const count = runCount(group)
        return [
          count === 1 ? '1 run' : `${count} runs`,
          `${text(first.fn)} ${text(or(first.event, first.route))}`,
          ...('route' in first ? [`${text(first.status)} ${text(or(first.code, '-'))}`] : []),
          ...(truthy(first.cause) ? [`cause ${text(first.cause)}`] : []),
          ...(truthy(first.outcome) ? [`outcome ${text(first.outcome)}`] : []),
          ...(ids(first) !== '' ? [ids(first)] : []),
          `first ${min(group.map((line) => line.at))} last ${max(group.map((line) => line.at))}`,
        ].join(' · ')
      }),
      ...carried.map(
        (group) =>
          `carried on · ${runCount(group)} of ${identityRuns.length} identity runs · personId ${text(or(group[0].personId, '-'))} into ${text(or(group[0].intoPersonId, '-'))} · post it if it is carried on at the next read too`,
      ),
    ],
  }
}

/**
 * Executions or rows from a file: the runbooks' fetch output (JSON lines), the CLI's own `--json`
 * output (`{ executions }` or `{ rows }`), or a JSON array. A run's function is its `fn` or, as the
 * API returns it, its `functionId`.
 */
export function parseRecords(content) {
  let values
  try {
    values = [JSON.parse(content)]
  } catch {
    values = content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  }
  return values
    .flatMap((value) =>
      Array.isArray(value) ? value : (value.executions ?? value.rows ?? [value]),
    )
    .map((record) =>
      record.functionId && !record.fn ? { ...record, fn: record.functionId } : record,
    )
}

class FetchFailed extends Error {}

/** An error's `type` from Appwrite, such as `general_unauthorized_scope`, or `-`: never other text. */
const errorType = (body) =>
  typeof body?.type === 'string' && /^[a-z0-9_]{1,64}$/.test(body.type) ? body.type : '-'

/**
 * Read-only GETs to the Appwrite API, paging as the runbooks do. Never prints the key, and never a
 * reply's body: a reply that isn't JSON, or has no `list` array, is a FETCH FAILED.
 */
export async function fetchReads({
  endpoint,
  project,
  key,
  from,
  stale,
  orderBy = '$createdAt',
  overdue = true,
}) {
  const get = async (what, path, queries, list) => {
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
    if (!response.ok) {
      const type = await response.json().then(errorType, () => '-')
      throw new FetchFailed(`FETCH FAILED ${what}: ${response.status} ${type}`)
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new FetchFailed(`FETCH FAILED ${what}: ${response.status} not JSON`)
    }
    if (!Array.isArray(body?.[list])) {
      throw new FetchFailed(`FETCH FAILED ${what}: ${response.status} no ${list} list`)
    }
    return body[list]
  }
  const order = { method: 'orderDesc', attribute: orderBy }
  const page = (offset) => [
    order,
    { method: 'limit', values: [100] },
    { method: 'offset', values: [offset] },
  ]
  const runs = []
  // The nightly check's: the scheduler's scheduled runs, 3 pages of 100.
  for (const offset of [0, 100, 200]) {
    const executions = await get(
      `scheduler at offset ${offset}`,
      '/functions/scheduler/executions',
      [{ method: 'equal', attribute: 'trigger', values: ['schedule'] }, ...page(offset)],
      'executions',
    )
    runs.push(...executions.map((run) => ({ ...run, fn: 'scheduler' })))
  }
  // The error lines': every function's runs, back past `from`, at most 2,000 each.
  const capped = []
  for (const fn of FUNCTIONS) {
    for (let offset = 0; ; offset += 100) {
      if (offset >= 2000) {
        capped.push(fn)
        break
      }
      const executions = (
        await get(
          `${fn} at offset ${offset}`,
          `/functions/${fn}/executions`,
          page(offset),
          'executions',
        )
      ).map((run) => ({ ...run, fn }))
      runs.push(...executions)
      if (executions.length < 100 || at(executions.at(-1)) < from) break
    }
  }
  // The nightly check's C: groups overdue now. Left out, it reads no table (`rows.read`), as the
  // reads job's key can't (#568).
  if (!overdue) return { runs, groups: null, capped: capped.map((fn) => ` ${fn}`).join('') }
  const groups = []
  for (const [what, query] of [
    ['groups', { method: 'lessThan', attribute: 'nextCheckAt', values: [stale] }],
    ['groups never due', { method: 'isNull', attribute: 'nextCheckAt' }],
  ]) {
    const rows = await get(
      what,
      '/tablesdb/main/tables/groups/rows',
      [query, { method: 'limit', values: [100] }],
      'rows',
    )
    groups.push(...rows)
  }
  return { runs, groups, capped: capped.map((fn) => ` ${fn}`).join('') }
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** The whole read: the lines to print, and the exit code. */
export async function read(args, env = process.env, now = Date.now()) {
  const usage = (problem) => ({
    lines: [
      problem,
      "Use: node scripts/reads.mjs --from <the last result's \"to\"> [--pending '<IDs>']",
      '       (--fetch [--to <time>] [--order-by-id] [--skip-overdue]',
      "        | --runs <file> --groups <file> --to <the blocks' \"$TO\"> [--capped '<functions>'])",
    ],
    code: 2,
  })
  let values
  try {
    ;({ values } = parseArgs({
      args,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        pending: { type: 'string' },
        runs: { type: 'string' },
        groups: { type: 'string' },
        capped: { type: 'string' },
        fetch: { type: 'boolean' },
        'order-by-id': { type: 'boolean' },
        'skip-overdue': { type: 'boolean' },
      },
    }))
  } catch (error) {
    // Its code only: the message would repeat the argument, which could be anything typed.
    return usage(`An argument isn't one this script takes (${error.code ?? error.name}).`)
  }
  const to = values.to ?? todate(now / 1000 - 1200)
  const stale = todate(now / 1000 - 7200)
  if (!values.from || !TIME.test(values.from) || !TIME.test(to)) {
    return usage('--from, and --to if given, are UTC times such as 2026-10-21T02:38:27Z.')
  }
  if (to <= values.from) return usage(`--to (${to}) has to be after --from.`)
  const from = values.from
  let runs
  let groups
  let capped = values.capped
    ? ` ${values.capped
        .trim()
        .split(/[\s,]+/)
        .join(' ')}`
    : ''
  if (values['skip-overdue'] && (!values.fetch || values.pending)) {
    return usage('--skip-overdue is for --fetch, and leaves out C, which --pending is for.')
  }
  if (values.fetch) {
    const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = env
    if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
      return usage('--fetch needs APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY.')
    }
    // The key goes only over HTTPS; plain HTTP only to this machine, as the tests' stand-in is.
    const endpoint = URL.canParse(APPWRITE_ENDPOINT) ? new URL(APPWRITE_ENDPOINT) : undefined
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint?.hostname ?? '')
    if (endpoint?.protocol !== 'https:' && !(endpoint?.protocol === 'http:' && local)) {
      return usage('APPWRITE_ENDPOINT has to be an https:// URL.')
    }
    try {
      ;({ runs, groups, capped } = await fetchReads({
        endpoint: APPWRITE_ENDPOINT,
        project: APPWRITE_PROJECT_ID,
        key: APPWRITE_API_KEY,
        from,
        stale,
        orderBy: values['order-by-id'] ? '$id' : '$createdAt',
        overdue: !values['skip-overdue'],
      }))
    } catch (error) {
      if (error instanceof FetchFailed) return { lines: [error.message], code: 2 }
      throw error
    }
  } else if (values.runs && values.groups) {
    // The files end at the blocks' TO, not at 20 minutes ago: a later --to would pass unread time.
    if (!values.to) return usage('With --runs, give --to: the blocks\' "$TO", where the files end.')
    let reading = '--runs'
    try {
      runs = parseRecords(readFileSync(values.runs, 'utf8'))
      reading = '--groups'
      groups = parseRecords(readFileSync(values.groups, 'utf8'))
    } catch (error) {
      // Its code or name only: a parse error's message quotes the file.
      return usage(`Can't read ${reading}'s file (${error.code ?? error.name}).`)
    }
  } else {
    return usage('Give --runs and --groups, or --fetch.')
  }
  const pending =
    values.pending && values.pending !== 'none'
      ? values.pending.split(/[\s,]+/).filter(Boolean)
      : []
  const nightly = nightlyResult(
    nightlyA(runs, from, to),
    nightlyB(runs, from, to),
    groups === null ? null : nightlyC(groups, stale),
    {
      from,
      to,
      pending,
    },
  )
  const errors = errorLines(runs, { from, to, capped })
  const notes = [
    ...nightly.notes,
    ...errors.notes,
    // Outside errorLines, whose lines match the runbook's jq: the fetch there prints CAPPED itself.
    // Only names in FUNCTIONS, so --capped's own text is never repeated.
    ...capped
      .split(' ')
      .filter((fn) => FUNCTIONS.includes(fn))
      .map((fn) => `capped ${fn}: more than 2,000 runs since --from; read sooner`),
  ]
  if (nightly.tooEarly || errors.verdict === 'TOO EARLY') {
    return {
      lines: [
        "TOO EARLY: a run hasn't finished. Run it again in a few minutes, with the same --from.",
        "If it's still waiting 20 minutes from now, it's stuck: post these as they stand (error-lines.md).",
        nightly.line,
        errors.line,
        ...notes,
      ],
      code: 2,
    }
  }
  return {
    lines: [
      'Post on #299:',
      nightly.line,
      errors.line,
      ...(notes.length > 0 ? ['', 'Post on #96:', ...notes] : []),
    ],
    // Exit 1 whenever there's something for #96, a removed membership or a merge carried on included.
    code: nightly.pass && errors.verdict === 'OK' && notes.length === 0 ? 0 : 1,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { lines: out, code } = await read(process.argv.slice(2))
    console.log(out.join('\n'))
    process.exit(code)
  } catch (error) {
    // Its name only: a message or a stack could quote a reply or a file.
    console.log(`STOPPED: ${error.name}. Nothing to post: run it again, or read by hand.`)
    process.exit(2)
  }
}
