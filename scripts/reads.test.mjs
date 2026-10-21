import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  errorLines,
  nightlyA,
  nightlyB,
  nightlyC,
  nightlyResult,
  parseRecords,
  read,
  SKIPPED,
  todate,
} from './reads.mjs'

// Made-up runs and groups, with IDs only, as the Appwrite API returns them.
const root = join(import.meta.dirname, '..')
const FROM = '2026-10-21T02:00:00Z'
const TO = '2026-10-21T06:00:00Z'

let ids = 0
/** One run of `fn` at `time` (HH:MM on the 21st), answering 200 with its request line. */
function run(time, { fn = 'scheduler', lines = [], ...fields } = {}) {
  const request = { fn, route: 'POST /run', status: 200, ms: 5 }
  return {
    $id: `run${String(++ids).padStart(5, '0')}`,
    $createdAt: `2026-10-21T${time}:00.000+00:00`,
    functionId: fn,
    trigger: 'schedule',
    status: 'completed',
    responseStatusCode: 200,
    duration: 2,
    logs: [request, ...lines].map((line) => JSON.stringify({ fn, ...line })).join('\n'),
    errors: '',
    fn,
    ...fields,
  }
}
const hourly = (fn = 'scheduler', ...extra) => [
  ...['01:42', '02:42', '03:42', '04:42'].map((time) => run(time, { fn })),
  ...extra,
]
const everyFunction = (...extra) => [
  ...['scheduler', 'statements', 'account', 'identity'].flatMap((fn) =>
    hourly(fn, run('05:42', { fn })),
  ),
  ...extra,
]

function nightly(runs, groups = [], pending = []) {
  const stale = '2026-10-21T04:00:00Z'
  const parts = [nightlyA(runs, FROM, TO), nightlyB(runs, FROM, TO), nightlyC(groups, stale)]
  return nightlyResult(...parts, { from: FROM, to: TO, pending })
}

describe('the nightly check', () => {
  it('passes, in the runbook’s form', () => {
    const { line, notes, pass } = nightly(hourly('scheduler', run('05:42')))
    assert.equal(
      line,
      `${FROM} → ${TO} · runs 4, not ok 0, longest gap 60 min, longest run 2 s · logged 4 of 4 · findings 0 · failed 0 · cut off 0 · removed 0 · overdue 0 · pending none · PASS`,
    )
    assert.deepEqual([pass, notes], [true, []])
  })

  it('fails on a gap over 125 minutes, measured from the run before the window', () => {
    assert.match(
      nightly([run('01:42'), run('02:42'), run('05:42')]).line,
      /longest gap 180 min, .* FAIL$/,
    )
    const late = { ...run('01:00'), $createdAt: '2026-10-20T23:10:00.000+00:00' }
    assert.match(
      nightly([late, run('02:42'), run('04:00'), run('05:30')]).line,
      /longest gap 212 min/,
    )
    // 125 minutes is a pass: one run Appwrite skipped.
    assert.match(nightly([run('01:42'), run('02:42'), run('04:47'), run('05:42')]).line, /PASS$/)
  })

  it('fails on a finding, and lists it', () => {
    const finding = {
      event: 'nightly_check_finding',
      groupId: 'g1',
      rule: 'I-3',
      transactionId: 't1',
    }
    const { line, notes } = nightly(hourly('scheduler', run('05:42', { lines: [finding] })))
    assert.match(line, / · findings 1 · .* · FAIL$/)
    assert.deepEqual(notes, ['2026-10-21T05:42:00Z nightly_check_finding g1 I-3 t1'])
  })

  it('fails when a run’s logs are gone, or a group failed or was cut off', () => {
    assert.match(
      nightly(hourly('scheduler', run('05:42', { logs: '' }))).line,
      / · logged 3 of 4 · .* FAIL$/,
    )
    for (const event of ['nightly_check_failed', 'nightly_check_cut_off']) {
      const runs = hourly('scheduler', run('05:42', { lines: [{ event, groupId: 'g1' }] }))
      assert.match(nightly(runs).line, /FAIL$/)
    }
  })

  it('lists a group removed from its team, without failing', () => {
    const removed = { event: 'team_membership_removed', groupId: 'g2', membershipId: 'm1' }
    const { line, notes } = nightly(hourly('scheduler', run('05:42', { lines: [removed] })))
    assert.match(line, / · removed 1 · .* PASS$/)
    assert.deepEqual(notes, ['2026-10-21T05:42:00Z team_membership_removed g2 - m1'])
  })

  it('fails on an overdue group, and lists a purged or archived one as pending once', () => {
    const overdue = { $id: 'g9', nextCheckAt: '2026-10-21T01:00:00.000+00:00' }
    const deleting = {
      $id: 'g1',
      nextCheckAt: null,
      $createdAt: '2026-10-20T01:00:00.000+00:00',
      deletingAt: '2026-10-21T01:00Z',
    }
    const archived = {
      $id: 'g2',
      nextCheckAt: '2026-10-21T01:00:00.000+00:00',
      archivedAt: '2026-10-21T01:00Z',
    }
    const later = { $id: 'g3', nextCheckAt: '2026-10-21T05:00:00.000+00:00' }
    const runs = hourly('scheduler', run('05:42'))
    const first = nightly(runs, [deleting, archived, later])
    assert.match(first.line, / · overdue 2 · pending g2, g1 · PASS$/)
    // The next read takes this read's pending IDs.
    const next = nightly(runs, [deleting, overdue], ['g2', 'g1'])
    assert.match(next.line, / · overdue 2 · pending none · FAIL$/)
    assert.deepEqual(next.notes, [
      'overdue g9 due 2026-10-21T01:00:00.000+00:00 deleting - archived -',
      'overdue g1 due never deleting 2026-10-21T01:00Z archived - · pending at the last read too',
    ])
  })

  it('says a run that hasn’t finished is too early', () => {
    const waiting = run('05:42', { status: 'processing', responseStatusCode: 0 })
    assert.equal(nightly(hourly('scheduler', waiting)).tooEarly, true)
    assert.equal(nightly(hourly('scheduler', run('05:42'))).tooEarly, false)
  })

  it('gives the runbook’s own example line', () => {
    // Hourly at :42 from 02:42 on the 21st to 01:42 on the 22nd, one of them 165 s long.
    const day = Array.from({ length: 25 }, (_, i) => {
      const time = new Date(Date.parse('2026-10-21T01:42:00Z') + i * 3600_000).toISOString()
      return {
        ...run('00:00'),
        $createdAt: time.replace('Z', '+00:00'),
        duration: i === 9 ? 165.4 : 3,
      }
    })
    const [from, to] = ['2026-10-21T02:38:27Z', '2026-10-22T02:20:00Z']
    const result = nightlyResult(nightlyA(day, from, to), nightlyB(day, from, to), [], { from, to })
    assert.equal(
      result.line,
      '2026-10-21T02:38:27Z → 2026-10-22T02:20:00Z · runs 24, not ok 0, longest gap 60 min, longest run 165 s · logged 24 of 24 · findings 0 · failed 0 · cut off 0 · removed 0 · overdue 0 · pending none · PASS',
    )
  })
})

const errors = (runs, options = {}) => errorLines(runs, { from: FROM, to: TO, ...options })

describe('the error lines', () => {
  it('are OK with none, and count a blocked send on its own', () => {
    const blocked = { event: 'reminder_failed', cause: 'EmailError validation_error 403' }
    const result = errors(everyFunction(run('03:10', { lines: [blocked] })))
    assert.equal(result.verdict, 'OK')
    assert.match(result.line, / · error lines 0 in 0 groups · repeating 0 · email blocked 1 · /)
  })

  it('say LOOK once and STUCK in 3 runs, and count a change notice only when it failed', () => {
    const draft = (time) =>
      run(time, { fn: 'statements', lines: [{ event: 'draft_failed', groupId: 'g1' }] })
    const once = errors(everyFunction(draft('03:10')))
    assert.equal(once.verdict, 'LOOK')
    assert.deepEqual(once.notes, [
      '1 run · statements draft_failed · groupId g1 · first 2026-10-21T03:10:00Z last 2026-10-21T03:10:00Z',
    ])
    assert.equal(
      errors(everyFunction(draft('03:10'), draft('04:10'), draft('05:10'))).verdict,
      'STUCK',
    )
    const notice = (outcome) =>
      run('03:10', { fn: 'identity', lines: [{ event: 'change_notice', outcome }] })
    assert.equal(errors(everyFunction(notice('sent'))).verdict, 'OK')
    assert.equal(errors(everyFunction(notice('failed'))).verdict, 'LOOK')
  })

  it('are INCOMPLETE when a run’s lines are gone, or a function was capped', () => {
    assert.equal(
      errors(everyFunction(run('03:10', { fn: 'ledger', trigger: 'http', logs: '' }))).verdict,
      'INCOMPLETE',
    )
    assert.equal(errors(everyFunction(), { capped: ' ledger' }).verdict, 'INCOMPLETE')
  })

  it('give the runbook’s own example line', () => {
    // Every function hourly; the scheduler's gaps a whole hour, the others' a little less.
    const at = (start, i, fn, fields, every = 3600) => {
      const time = new Date(Date.parse(start) + i * every * 1000)
        .toISOString()
        .replace('Z', '+00:00')
      return { ...run('00:00', { fn, ...fields }), $createdAt: time }
    }
    const blocked = [1, 2, 3].map(() => ({
      event: 'reminder_failed',
      cause: 'EmailError validation_error 403',
    }))
    const runs = [
      ...Array.from({ length: 25 }, (_, i) =>
        at('2026-10-21T01:42:00Z', i, 'scheduler', { lines: blocked }),
      ),
      ...['statements', 'account', 'identity'].flatMap((fn) =>
        Array.from({ length: 25 }, (_, i) => at('2026-10-21T01:43:00Z', i, fn, {}, 3590)),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        at('2026-10-21T03:05:00Z', i, 'identity', { trigger: 'event' }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        at('2026-10-21T03:06:00Z', i, 'groups', { trigger: 'http' }),
      ),
      ...Array.from({ length: 140 }, (_, i) => ({
        ...at('2026-10-21T03:07:00Z', 0, 'ledger', { trigger: 'http' }),
        $createdAt: new Date(Date.parse('2026-10-21T03:07:00Z') + i * 60_000)
          .toISOString()
          .replace('Z', '+00:00'),
      })),
    ]
    const { line } = errorLines(runs, { from: '2026-10-21T02:38:27Z', to: '2026-10-22T02:20:00Z' })
    assert.equal(
      line,
      'errors 2026-10-21T02:38:27Z → 2026-10-22T02:20:00Z · runs scheduler 24, statements 24, account 24, identity 31, groups 5, ledger 140 · not ok 0 · longest gap 60 min (scheduler) · logged 248 of 248 · error lines 0 in 0 groups · repeating 0 · email blocked 72 · merges carried on 0 · OK',
    )
  })
})

describe('the skipped events', () => {
  it('are LEVELS’ log and warn events and the nightly check’s three, here and in error-lines.md', () => {
    const log = readFileSync(join(root, 'packages/server/src/http/log.ts'), 'utf8')
    const levels = log.match(/const LEVELS[^{]*\{([^}]*)\}/)[1]
    const quiet = [...levels.matchAll(/^\s*(\w+): '(log|warn)',$/gm)].map((match) => match[1])
    const expected = [
      ...quiet,
      'nightly_check_finding',
      'nightly_check_failed',
      'team_membership_removed',
    ].sort()
    assert.ok(quiet.length > 20)
    assert.deepEqual([...SKIPPED].sort(), expected)
    const runbook = readFileSync(join(root, 'docs/engineering/error-lines.md'), 'utf8')
    const listed = [...runbook.match(/def skipped: IN\(([^)]*)\)/)[1].matchAll(/"(\w+)"/g)]
    assert.deepEqual(listed.map((match) => match[1]).sort(), expected)
  })
})

/** The runbooks' own jq programs, as the fallback runs them (nightly-check.md, error-lines.md). */
function runbookPrograms() {
  const nightlyDoc = readFileSync(join(root, 'docs/engineering/nightly-check.md'), 'utf8')
  const errorsDoc = readFileSync(join(root, 'docs/engineering/error-lines.md'), 'utf8')
  const [a, b] = [
    ...nightlyDoc.matchAll(/jq -rs --arg from "\$FROM" --arg to "\$TO" '\n(.*?)\n' "\$RUNS"/gs),
  ].map((match) => match[1])
  const due = nightlyDoc.match(/"limit","values":\[100\]}' \\\n {2}\| jq -r '(.*?)'\nappwrite/s)[1]
  const never = nightlyDoc.match(/jq -r --arg stale "\$STALE" '(.*?)'\n```/s)[1]
  const errorsProgram = errorsDoc.match(/--arg failed "\$FAILED" '\n(.*?)\n' "\$RUNS"/s)[1]
  return { a, b, due, never, errors: errorsProgram }
}

function jq(program, input, args) {
  const out = spawnSync('jq', [...args, program], { input, encoding: 'utf8' })
  assert.equal(out.error, undefined, 'jq is needed for this test: it runs the runbooks’ fallback')
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.split('\n').filter((line) => line !== '')
}

/** Runs of every kind, from a seed: the cases both reads must agree on. */
function mixed(seed) {
  let state = seed
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const pick = (items) => items[Math.floor(random() * items.length)]
  const events = [
    { event: 'draft_failed', groupId: 'g1' },
    { event: 'draft_failed', groupId: 'g2', cause: 'TypeError' },
    { event: 'reminder_failed', cause: 'EmailError validation_error 403', reminderId: 'r1' },
    { event: 'reminder_failed', cause: 'EmailError invalid_api_key' },
    { event: 'change_notice', outcome: 'failed', userId: 'u1', count: 2 },
    { event: 'change_notice', outcome: 'sent', userId: 'u1' },
    { event: 'password_notice', outcome: 'failed', userId: 'u2' },
    { event: 'merge_carries_on', personId: 'p1', intoPersonId: 'p2' },
    { event: 'merge_left_schedule', personId: 'p1', scheduleId: 's1' },
    { event: 'nightly_check_finding', groupId: 'g3', rule: 'I-1', transactionId: 't9' },
    { event: 'nightly_check_failed', groupId: 'g4', cause: 'AppwriteException' },
    { event: 'nightly_check_cut_off', groupId: 'g5' },
    { event: 'team_membership_removed', groupId: 'g6', membershipId: 'm2' },
    { event: 'balances_row_deleted', groupId: 'g7', rowId: 0 },
    { route: 'POST /x', status: 500, code: 'INTERNAL', cause: 'TypeError' },
    { route: 'GET /y', status: 403, code: 'FORBIDDEN' },
    { event: null },
    {},
  ]
  const runs = []
  const start = Date.parse(FROM) - 3 * 3600_000
  for (const fn of ['scheduler', 'statements', 'account', 'identity', 'groups', 'ledger']) {
    for (let i = 0; i < 9; i++) {
      const scheduledRun = ['groups', 'ledger'].includes(fn) ? random() < 0.2 : random() < 0.8
      const time = new Date(
        start + i * 3600_000 * pick([0.5, 1, 1, 1, 1.4]) + Math.floor(random() * 600) * 1000,
      )
      const lines = Array.from({ length: Math.floor(random() * 3) }, () => pick(events))
      const request = {
        fn,
        route: pick(['POST /run', 'POST /run', null]),
        status: pick([200, 200, 500]),
      }
      const logs = random() < 0.1 ? '' : [request, ...lines]
      const run = {
        $id: `x${seed}-${fn}-${i}`,
        $createdAt: time.toISOString().replace('Z', '+00:00'),
        functionId: fn,
        fn,
        trigger: scheduledRun ? 'schedule' : pick(['http', 'event']),
        status: pick(['completed', 'completed', 'completed', 'failed', 'waiting']),
        responseStatusCode: pick([200, 200, 200, 500, 403, 0, null]),
        duration: random() * 900,
        logs:
          typeof logs === 'string'
            ? logs
            : logs.map((line) => JSON.stringify({ fn, ...line })).join('\n'),
        errors: random() < 0.2 ? 'not json\n[1,2]\n42' : '',
      }
      runs.push(run, ...(random() < 0.1 ? [{ ...run }] : []))
    }
  }
  const groups = Array.from({ length: 6 }, (_, i) => ({
    $id: `g${seed}-${i}`,
    $createdAt: new Date(start + i * 1800_000).toISOString().replace('Z', '+00:00'),
    nextCheckAt: pick([null, new Date(start + i * 1800_000).toISOString().replace('Z', '+00:00')]),
    deletingAt: pick([null, '2026-10-21T00:00Z']),
    archivedAt: pick([null, null, '2026-10-21T00:00Z']),
  }))
  return { runs, groups }
}

describe('the same lines as the runbooks’ own jq', () => {
  const programs = runbookPrograms()
  const window = ['--arg', 'from', FROM, '--arg', 'to', TO]
  const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n')

  for (let seed = 1; seed <= 25; seed++) {
    it(`agrees on mixed runs and groups, seed ${seed}`, () => {
      const { runs, groups } = mixed(seed)
      // What the nightly check fetches: the scheduler's scheduled runs, and C's two queries.
      const scheduled = runs.filter((r) => r.fn === 'scheduler' && r.trigger === 'schedule')
      const nightlyRuns = jsonl(scheduled.map(({ fn, ...r }) => r))
      assert.deepEqual(nightlyA(runs, FROM, TO), jq(programs.a, nightlyRuns, ['-rs', ...window]))
      assert.deepEqual(nightlyB(runs, FROM, TO), jq(programs.b, nightlyRuns, ['-rs', ...window]))
      const stale = '2026-10-21T01:30:00Z'
      const due = groups.filter(
        (g) => g.nextCheckAt && Date.parse(g.nextCheckAt) < Date.parse(stale),
      )
      const never = groups.filter((g) => g.nextCheckAt === null)
      assert.deepEqual(nightlyC(groups, stale), [
        ...jq(programs.due, JSON.stringify({ rows: due }), ['-r']),
        ...jq(programs.never, JSON.stringify({ rows: never }), ['-r', '--arg', 'stale', stale]),
      ])
      for (const [capped, failed] of [
        ['', ''],
        [' ledger', ''],
        ['', 'groups'],
      ]) {
        const ours = errorLines(runs, { from: FROM, to: TO, capped, failed })
        const theirs = jq(programs.errors, jsonl(runs), [
          '-rs',
          ...window,
          ...['--arg', 'capped', capped, '--arg', 'failed', failed],
        ])
        assert.deepEqual([ours.line, ...ours.notes], theirs)
      }
    })
  }
})

describe('parseRecords', () => {
  it('reads JSON lines, the CLI’s own output, or an array, and names each run’s function', () => {
    const lines = '{"$id":"a","functionId":"ledger"}\n\n{"$id":"b","fn":"groups"}\n'
    assert.deepEqual(parseRecords(lines), [
      { $id: 'a', functionId: 'ledger', fn: 'ledger' },
      { $id: 'b', fn: 'groups' },
    ])
    assert.deepEqual(parseRecords('{"total":1,"rows":[{"$id":"g1"}]}'), [{ $id: 'g1' }])
    assert.deepEqual(parseRecords('{"executions":[]}\n{"executions":[{"$id":"c"}]}'), [
      { $id: 'c' },
    ])
    assert.deepEqual(parseRecords('[{"$id":"d"}]'), [{ $id: 'd' }])
  })
})

describe('the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reads-'))
  after(() => rmSync(dir, { recursive: true }))
  const NOW = Date.parse('2026-10-21T06:20:00Z')

  function files(runs, groups = []) {
    writeFileSync(join(dir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n'))
    writeFileSync(join(dir, 'groups.json'), JSON.stringify({ rows: groups }))
    return ['--runs', join(dir, 'runs.jsonl'), '--groups', join(dir, 'groups.json')]
  }

  it('prints the two lines to post, from the files, and exits 0', async () => {
    const { lines, code } = await read(['--from', FROM, ...files(everyFunction())], {}, NOW)
    assert.equal(code, 0)
    assert.deepEqual(lines.slice(0, 2), [
      'Post on #299:',
      `${FROM} → ${TO} · runs 4, not ok 0, longest gap 60 min, longest run 2 s · logged 4 of 4 · findings 0 · failed 0 · cut off 0 · removed 0 · overdue 0 · pending none · PASS`,
    ])
    assert.match(
      lines[2],
      /^errors .* · runs scheduler 4, statements 4, account 4, identity 4, groups 0, ledger 0 · .* · OK$/,
    )
    assert.equal(lines.length, 3)
  })

  it('exits 1 with the lines for #96 when the read fails, or the error lines need a look', async () => {
    const overdue = [{ $id: 'g9', nextCheckAt: '2026-10-21T01:00:00.000+00:00' }]
    const failed = await read(['--from', FROM, ...files(everyFunction(), overdue)], {}, NOW)
    assert.equal(failed.code, 1)
    assert.deepEqual(failed.lines.slice(3), [
      '',
      'Post on #96:',
      'overdue g9 due 2026-10-21T01:00:00.000+00:00 deleting - archived -',
    ])
    const draft = run('03:10', {
      fn: 'statements',
      lines: [{ event: 'draft_failed', groupId: 'g1' }],
    })
    const look = await read(['--from', FROM, ...files(everyFunction(draft))], {}, NOW)
    assert.equal(look.code, 1)
    assert.match(look.lines[1], / · PASS$/)
    assert.match(look.lines[2], / · LOOK$/)
  })

  it('exits 2 with nothing to post when it’s too early, or the arguments are wrong', async () => {
    const waiting = run('05:50', { status: 'waiting', responseStatusCode: 0 })
    const early = await read(['--from', FROM, ...files(everyFunction(waiting))], {}, NOW)
    assert.equal(early.code, 2)
    assert.match(early.lines[0], /^TOO EARLY/)
    assert.match(early.lines[2], /, not ok 1, .* · FAIL$/)
    assert.equal((await read(['--from', 'yesterday', ...files([])], {}, NOW)).code, 2)
    assert.equal((await read(['--from', FROM], {}, NOW)).code, 2)
    assert.equal((await read(['--from', FROM, '--fetch'], {}, NOW)).code, 2)
  })

  it('runs as a script', () => {
    const out = spawnSync(
      process.execPath,
      [join(root, 'scripts/reads.mjs'), '--from', FROM, '--to', TO, ...files(everyFunction())],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /^Post on #299:\n.* · PASS\nerrors .* · OK\n$/)
  })

  it('counts a group as overdue 2 hours after its time, from now', async () => {
    assert.equal(todate(NOW / 1000 - 7200), '2026-10-21T04:20:00Z')
    const groups = [
      { $id: 'g1', nextCheckAt: '2026-10-21T04:50:00.000+00:00' },
      { $id: 'g2', nextCheckAt: '2026-10-21T03:50:00.000+00:00' },
    ]
    const { lines } = await read(['--from', FROM, ...files(everyFunction(), groups)], {}, NOW)
    assert.match(lines[1], / · overdue 1 · /)
    assert.equal(lines.at(-1), 'overdue g2 due 2026-10-21T03:50:00.000+00:00 deleting - archived -')
  })
})

describe('--fetch', () => {
  const KEY = 'test-key-never-printed'

  /** A stand-in for the Appwrite API: executions by function and groups, as `GET`s only. */
  async function serve(data, { status } = {}) {
    const requests = []
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost')
      requests.push({ method: request.method, path: url.pathname, headers: request.headers })
      if (status) {
        response.writeHead(status, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({ message: 'secret detail', type: 'general_unauthorized_scope' }),
        )
      }
      const queries = url.searchParams.getAll('queries[]').map((q) => JSON.parse(q))
      const query = (method) => queries.find((q) => q.method === method)
      let body
      if (url.pathname === '/v1/tablesdb/main/tables/groups/rows') {
        body = { rows: query('isNull') ? data.never : data.due }
      } else {
        const fn = url.pathname.split('/')[3]
        let runs = data.runs.filter((r) => r.fn === fn)
        if (query('equal')) runs = runs.filter((r) => r.trigger === 'schedule')
        runs.sort((a, b) => (a.$createdAt < b.$createdAt ? 1 : -1))
        const offset = query('offset').values[0]
        body = {
          executions: runs
            .slice(offset, offset + query('limit').values[0])
            .map(({ fn: _, ...r }) => r),
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const env = {
      APPWRITE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/`,
      APPWRITE_PROJECT_ID: 'ledgerly-test',
      APPWRITE_API_KEY: KEY,
    }
    return { env, requests, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  it('fetches with GETs only, pages back past --from, and prints what the files give', async () => {
    // 150 ledger requests in the window: two pages.
    const ledger = Array.from({ length: 150 }, (_, i) => ({
      ...run('03:00', { fn: 'ledger', trigger: 'http' }),
      $createdAt: new Date(Date.parse('2026-10-21T03:00:00Z') + i * 60_000)
        .toISOString()
        .replace('Z', '+00:00'),
    }))
    // 246 more account runs before the window: the first page reaches back past --from.
    const older = Array.from({ length: 246 }, (_, i) => ({
      ...run('00:00', { fn: 'account' }),
      $createdAt: new Date(Date.parse('2026-10-20T23:00:00Z') - i * 3600_000)
        .toISOString()
        .replace('Z', '+00:00'),
    }))
    const runs = everyFunction(...ledger, ...older)
    const api = await serve({ runs, due: [], never: [] })
    try {
      const fetched = await read(
        ['--from', FROM, '--fetch'],
        api.env,
        Date.parse('2026-10-21T06:20:00Z'),
      )
      assert.equal(fetched.code, 0)
      assert.match(fetched.lines[2], /, ledger 150 · /)
      assert.ok(api.requests.every((r) => r.method === 'GET'))
      assert.ok(
        api.requests.every(
          (r) =>
            r.headers['x-appwrite-key'] === KEY &&
            r.headers['x-appwrite-project'] === 'ledgerly-test',
        ),
      )
      const pages = (path) => api.requests.filter((r) => r.path === path).length
      assert.equal(pages('/v1/functions/scheduler/executions'), 4)
      assert.equal(pages('/v1/functions/ledger/executions'), 2)
      assert.equal(pages('/v1/functions/account/executions'), 1)
      assert.equal(pages('/v1/tablesdb/main/tables/groups/rows'), 2)
      assert.ok(!fetched.lines.join('\n').includes(KEY))
    } finally {
      await api.close()
    }
  })

  it('stops with FETCH FAILED and the error’s type, never its message or the key', async () => {
    const api = await serve({}, { status: 401 })
    try {
      const failed = await read(
        ['--from', FROM, '--fetch'],
        api.env,
        Date.parse('2026-10-21T06:20:00Z'),
      )
      assert.equal(failed.code, 2)
      assert.deepEqual(failed.lines, [
        'FETCH FAILED scheduler at offset 0: 401 general_unauthorized_scope',
      ])
    } finally {
      await api.close()
    }
  })

  it('says CAPPED when a function has more than 2,000 runs since --from', async () => {
    const many = Array.from({ length: 2050 }, (_, i) => ({
      ...run('02:00', { fn: 'groups', trigger: 'http' }),
      $createdAt: new Date(Date.parse('2026-10-21T02:00:00Z') + i * 5_000)
        .toISOString()
        .replace('Z', '+00:00'),
    }))
    const api = await serve({ runs: everyFunction(...many), due: [], never: [] })
    try {
      const capped = await read(
        ['--from', FROM, '--fetch'],
        api.env,
        Date.parse('2026-10-21T06:20:00Z'),
      )
      assert.match(capped.lines[2], / · INCOMPLETE$/)
      assert.equal(
        api.requests.filter((r) => r.path === '/v1/functions/groups/executions').length,
        20,
      )
    } finally {
      await api.close()
    }
  })
})
