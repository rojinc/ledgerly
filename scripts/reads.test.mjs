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
// 20 minutes after TO, as a read's default --to is.
const NOW = Date.parse('2026-10-21T06:20:00Z')

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

  it('notes a run of 700 s or more, without failing', () => {
    const { line, notes } = nightly(hourly('scheduler', run('05:42', { duration: 700 })))
    assert.match(line, /longest run 700 s · .* PASS$/)
    assert.deepEqual(notes, ['longest run 700 s: post it on #96 if it repeats'])
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

  it('say STUCK, not INCOMPLETE, when a repeating error and a run with no lines come together', () => {
    const draft = (time) =>
      run(time, { fn: 'statements', lines: [{ event: 'draft_failed', groupId: 'g1' }] })
    const gone = run('03:20', { fn: 'ledger', trigger: 'http', logs: '' })
    const result = errors(everyFunction(draft('03:10'), draft('04:10'), draft('05:10'), gone))
    assert.equal(result.verdict, 'STUCK')
    assert.match(result.line, / · logged 19 of 20 · error lines 3 in 1 groups · repeating 1 · /)
  })

  it('read the error lines in `errors`, where console.error writes them', () => {
    const failing = run('03:10', {
      fn: 'statements',
      trigger: 'http',
      responseStatusCode: 500,
      logs: '',
      errors: [
        { fn: 'statements', event: 'draft_failed', groupId: 'g1' },
        { fn: 'statements', route: 'POST /drafts', status: 500, code: 'INTERNAL' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    })
    const result = errors(everyFunction(failing))
    assert.equal(result.verdict, 'LOOK')
    assert.match(result.line, / · logged 16 of 16 · error lines 2 in 2 groups · /)
  })

  it('list a merge carried on, saying to post it at the next read', () => {
    const carried = run('03:10', {
      fn: 'identity',
      lines: [{ event: 'merge_carries_on', personId: 'p1', intoPersonId: 'p2' }],
    })
    const result = errors(everyFunction(carried))
    assert.equal(result.verdict, 'OK')
    assert.deepEqual(result.notes, [
      'carried on · 1 of 5 identity runs · personId p1 into p2 · post it if it is carried on at the next read too',
    ])
  })

  it('keep two groups apart by their IDs alone', () => {
    const twice = run('03:10', {
      fn: 'statements',
      lines: [
        { event: 'draft_failed', groupId: 'g1' },
        { event: 'draft_failed', groupId: 'g2' },
      ],
    })
    assert.match(errors(everyFunction(twice)).line, / · error lines 2 in 2 groups · /)
  })

  it('say LOOK, not INCOMPLETE, for a run that failed without a line', () => {
    const died = run('03:10', { status: 'failed', responseStatusCode: 500, logs: '' })
    const result = errors(everyFunction(died))
    assert.equal(result.verdict, 'LOOK')
    assert.match(result.line, / · not ok 1 · .* · logged 16 of 16 · /)
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
    const quiet = [...levels.matchAll(/^\s*(\w+): '(log|warn)',(\s*\/\/.*)?$/gm)].map(
      (match) => match[1],
    )
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
      // Some lines in `errors`, where `console.error` writes them, and some in `logs`.
      const all = random() < 0.1 ? [] : [request, ...lines]
      const toErrors = all.map(() => random() < 0.4)
      const json = (list) => list.map((line) => JSON.stringify({ fn, ...line })).join('\n')
      const run = {
        $id: `x${seed}-${fn}-${i}`,
        $createdAt: time.toISOString().replace('Z', '+00:00'),
        functionId: fn,
        fn,
        trigger: scheduledRun ? 'schedule' : pick(['http', 'event']),
        status: pick(['completed', 'completed', 'completed', 'failed', 'waiting']),
        responseStatusCode: pick([200, 200, 200, 500, 403, 0, null]),
        duration: random() * 900,
        logs: json(all.filter((_, i) => !toErrors[i])),
        errors: [
          random() < 0.2 ? 'not json\n[1,2]\n42' : '',
          json(all.filter((_, i) => toErrors[i])),
        ]
          .filter((part) => part !== '')
          .join('\n'),
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

  function files(runs, groups = []) {
    writeFileSync(join(dir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n'))
    writeFileSync(join(dir, 'groups.json'), JSON.stringify({ rows: groups }))
    return ['--runs', join(dir, 'runs.jsonl'), '--groups', join(dir, 'groups.json')]
  }

  it('prints the two lines to post, from the files, and exits 0', async () => {
    const { lines, code } = await read(
      ['--from', FROM, '--to', TO, ...files(everyFunction())],
      {},
      NOW,
    )
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
    const failed = await read(
      ['--from', FROM, '--to', TO, ...files(everyFunction(), overdue)],
      {},
      NOW,
    )
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
    const look = await read(['--from', FROM, '--to', TO, ...files(everyFunction(draft))], {}, NOW)
    assert.equal(look.code, 1)
    assert.match(look.lines[1], / · PASS$/)
    assert.match(look.lines[2], / · LOOK$/)
  })

  it('exits 1 for any line under Post on #96, even when it passes and is OK', async () => {
    const removed = { event: 'team_membership_removed', groupId: 'g2', membershipId: 'm1' }
    const runs = everyFunction(run('03:10', { lines: [removed] }))
    const { lines, code } = await read(['--from', FROM, '--to', TO, ...files(runs)], {}, NOW)
    assert.match(lines[1], / · removed 1 · .* · PASS$/)
    assert.match(lines[2], / · OK$/)
    assert.deepEqual(lines.slice(3), [
      '',
      'Post on #96:',
      '2026-10-21T03:10:00Z team_membership_removed g2 - m1',
    ])
    assert.equal(code, 1)
  })

  it('exits 2 with nothing to post when it’s too early, or the arguments are wrong', async () => {
    const waiting = run('05:50', { status: 'waiting', responseStatusCode: 0 })
    const early = await read(
      ['--from', FROM, '--to', TO, ...files(everyFunction(waiting))],
      {},
      NOW,
    )
    assert.equal(early.code, 2)
    assert.match(early.lines[0], /^TOO EARLY/)
    assert.match(early.lines[2], /, not ok 1, .* · FAIL$/)
    assert.equal((await read(['--from', 'yesterday', ...files([])], {}, NOW)).code, 2)
    assert.equal((await read(['--from', FROM], {}, NOW)).code, 2)
    const backwards = await read(['--from', TO, '--to', FROM, ...files([])], {}, NOW)
    assert.deepEqual(
      [backwards.code, backwards.lines[0]],
      [2, `--to (${FROM}) has to be after --from.`],
    )
    assert.equal((await read(['--from', FROM, '--fetch'], {}, NOW)).code, 2)
  })

  it('exits 2 for a run of any function that hasn’t finished, not only the scheduler’s', async () => {
    const waiting = run('05:50', { fn: 'statements', status: 'waiting', responseStatusCode: 0 })
    const early = await read(
      ['--from', FROM, '--to', TO, ...files(everyFunction(waiting))],
      {},
      NOW,
    )
    assert.equal(early.code, 2)
    assert.match(early.lines[0], /^TOO EARLY/)
    assert.match(early.lines[2], / · PASS$/)
  })

  it('exits 1 on an INCOMPLETE or STUCK error read, even with no lines for #96', async () => {
    const gone = run('03:10', { fn: 'ledger', trigger: 'http', logs: '' })
    const incomplete = await read(
      ['--from', FROM, '--to', TO, ...files(everyFunction(gone))],
      {},
      NOW,
    )
    assert.match(incomplete.lines[2], / · INCOMPLETE$/)
    assert.deepEqual([incomplete.lines.length, incomplete.code], [3, 1])
    // statements runs at 01:42 and 05:42 only: a 240-minute gap.
    const gap = [
      ...['scheduler', 'account', 'identity'].flatMap((fn) => hourly(fn, run('05:42', { fn }))),
      run('01:42', { fn: 'statements' }),
      run('05:42', { fn: 'statements' }),
    ]
    const stuck = await read(['--from', FROM, '--to', TO, ...files(gap)], {}, NOW)
    assert.match(stuck.lines[2], / · longest gap 240 min \(statements\) · .* · STUCK$/)
    assert.deepEqual([stuck.lines.length, stuck.code], [3, 1])
  })

  it('takes --pending as the result line prints it, with a comma and a space', async () => {
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
    const args = ['--from', FROM, '--to', TO, '--pending', 'g2, g1']
    const { lines, code } = await read(
      [...args, ...files(everyFunction(), [deleting, archived])],
      {},
      NOW,
    )
    assert.match(lines[1], / · overdue 2 · pending none · FAIL$/)
    assert.deepEqual(lines.slice(5), [
      'overdue g2 due 2026-10-21T01:00:00.000+00:00 deleting - archived 2026-10-21T01:00Z · pending at the last read too',
      'overdue g1 due never deleting 2026-10-21T01:00Z archived - · pending at the last read too',
    ])
    assert.equal(code, 1)
  })

  it('names a --capped function for #96, but never repeats other text given there', async () => {
    const args = ['--from', FROM, '--to', TO, '--capped', 'ledger, typed-text']
    const { lines, code } = await read([...args, ...files(everyFunction())], {}, NOW)
    assert.match(lines[2], / · INCOMPLETE$/)
    assert.deepEqual(lines.slice(3), [
      '',
      'Post on #96:',
      'capped ledger: more than 2,000 runs since --from; read sooner',
    ])
    assert.ok(!lines.join('\n').includes('typed-text'))
    assert.equal(code, 1)
  })

  it('refuses files without --to, which must be where the files end', async () => {
    const { lines, code } = await read(['--from', FROM, ...files(everyFunction())], {}, NOW)
    assert.deepEqual(
      [code, lines[0]],
      [2, 'With --runs, give --to: the blocks\' "$TO", where the files end.'],
    )
  })

  it('exits 2 with the usage, never the argument or the file’s text, when it can’t read them', async () => {
    const unknown = await read(['--from', FROM, '--bogus-key-text'], {}, NOW)
    assert.deepEqual(
      [unknown.code, unknown.lines[0]],
      [2, "An argument isn't one this script takes (ERR_PARSE_ARGS_UNKNOWN_OPTION)."],
    )
    assert.ok(!unknown.lines.join('\n').includes('bogus'))
    // --pending g1, g2 without quotes: g2 is a stray argument.
    const unquoted = await read(['--from', FROM, '--pending', 'g1,', 'g2'], {}, NOW)
    assert.match(unquoted.lines[0], /\(ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL\)\.$/)
    assert.equal(unquoted.code, 2)
    const args = ['--from', FROM, '--to', TO]
    const missing = await read(
      [...args, '--runs', join(dir, 'none.jsonl'), '--groups', join(dir, 'none.json')],
      {},
      NOW,
    )
    assert.deepEqual([missing.code, missing.lines[0]], [2, "Can't read --runs's file (ENOENT)."])
    const [runsArg, runsFile, groupsArg, groupsFile] = files(everyFunction())
    writeFileSync(groupsFile, 'a private line\n')
    const bad = await read([...args, runsArg, runsFile, groupsArg, groupsFile], {}, NOW)
    assert.deepEqual([bad.code, bad.lines[0]], [2, "Can't read --groups's file (SyntaxError)."])
    assert.ok(!bad.lines.join('\n').includes('private'))
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

  it('stops with the error’s name only and exits 2, as a script, when a run can’t be read', () => {
    // A run with no $createdAt: reading its time throws.
    const [, runsFile, , groupsFile] = files([
      { $id: 'x', fn: 'scheduler', trigger: 'schedule', logs: 'a private line' },
    ])
    const out = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/reads.mjs'),
        '--from',
        FROM,
        '--to',
        TO,
        '--runs',
        runsFile,
        '--groups',
        groupsFile,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(out.status, 2)
    assert.equal(
      out.stdout,
      'STOPPED: TypeError. Nothing to post: run it again, or read by hand.\n',
    )
    assert.equal(out.stderr, '')
  })

  it('counts a group as overdue 2 hours after its time, from now', async () => {
    assert.equal(todate(NOW / 1000 - 7200), '2026-10-21T04:20:00Z')
    const groups = [
      { $id: 'g1', nextCheckAt: '2026-10-21T04:50:00.000+00:00' },
      { $id: 'g2', nextCheckAt: '2026-10-21T03:50:00.000+00:00' },
    ]
    const { lines } = await read(
      ['--from', FROM, '--to', TO, ...files(everyFunction(), groups)],
      {},
      NOW,
    )
    assert.match(lines[1], / · overdue 1 · /)
    assert.equal(lines.at(-1), 'overdue g2 due 2026-10-21T03:50:00.000+00:00 deleting - archived -')
  })
})

describe('--fetch', () => {
  const KEY = 'test-key-never-printed'

  /** A stand-in for the Appwrite API: executions by function and groups, as `GET`s only. */
  async function serve(data, { status, type = 'general_unauthorized_scope', raw } = {}) {
    const requests = []
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost')
      const sent = url.searchParams.getAll('queries[]').map((q) => JSON.parse(q))
      requests.push({
        method: request.method,
        url: request.url,
        path: url.pathname,
        headers: request.headers,
        queries: sent,
      })
      if (status || raw !== undefined) {
        const json = raw === undefined
        response.writeHead(status ?? 200, {
          'content-type': json ? 'application/json' : 'text/html',
        })
        return response.end(json ? JSON.stringify({ message: 'secret detail', type }) : raw)
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
      // The key goes in its header only, never in a URL, which proxies and servers log.
      assert.ok(api.requests.every((r) => !r.url.includes(KEY)))
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
      // The runbooks' queries: the scheduler's scheduled runs, and C's 2 hours before now.
      const first = api.requests.find((r) => r.path === '/v1/functions/scheduler/executions')
      assert.deepEqual(first.queries[0], {
        method: 'equal',
        attribute: 'trigger',
        values: ['schedule'],
      })
      const due = api.requests.find((r) => r.path === '/v1/tablesdb/main/tables/groups/rows')
      assert.deepEqual(due.queries[0], {
        method: 'lessThan',
        attribute: 'nextCheckAt',
        values: ['2026-10-21T04:20:00Z'],
      })
      for (const groups of api.requests.filter((r) => r.path.endsWith('/groups/rows'))) {
        assert.deepEqual(groups.queries[1], { method: 'limit', values: [100] })
      }
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

  it('prints an error’s type only when it reads as one', async () => {
    const api = await serve({}, { status: 401, type: 'Key test-key-never-printed is wrong' })
    try {
      const failed = await read(['--from', FROM, '--fetch'], api.env, NOW)
      assert.deepEqual(failed, { lines: ['FETCH FAILED scheduler at offset 0: 401 -'], code: 2 })
    } finally {
      await api.close()
    }
  })

  it('stops with FETCH FAILED, never the body, when a reply isn’t the JSON it expects', async () => {
    for (const [status, raw, says] of [
      [undefined, '<html>a private page</html>', '200 not JSON'],
      [undefined, 'null', '200 no executions list'],
      [undefined, '{"executions":"a private value"}', '200 no executions list'],
      // An edge or proxy's error page: its status, and no type.
      [502, '<html>a private page</html>', '502 -'],
    ]) {
      const api = await serve({}, { status, raw })
      try {
        const failed = await read(['--from', FROM, '--fetch'], api.env, NOW)
        assert.deepEqual(failed, {
          lines: [`FETCH FAILED scheduler at offset 0: ${says}`],
          code: 2,
        })
      } finally {
        await api.close()
      }
    }
  })

  it('never follows a redirect, so the key never reaches another host', async () => {
    const elsewhere = []
    const other = createServer((request, response) => {
      elsewhere.push(request.headers)
      response.end('{}')
    })
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
    const redirect = createServer((request, response) => {
      response.writeHead(302, {
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
      const result = await read(
        ['--from', FROM, '--fetch'],
        env,
        Date.parse('2026-10-21T06:20:00Z'),
      )
      assert.deepEqual(result, {
        lines: ['FETCH FAILED scheduler at offset 0: 302 redirect refused'],
        code: 2,
      })
      assert.deepEqual(elsewhere, [])
    } finally {
      await new Promise((resolve) => redirect.close(resolve))
      await new Promise((resolve) => other.close(resolve))
    }
  })

  it('sends the key only over HTTPS, or to this machine', async () => {
    for (const endpoint of [
      'http://cloud.example/v1',
      'http://localhost.example/v1',
      'ftp://cloud.example/v1',
      'not a url',
    ]) {
      const env = { APPWRITE_ENDPOINT: endpoint, APPWRITE_PROJECT_ID: 'p', APPWRITE_API_KEY: KEY }
      const result = await read(
        ['--from', FROM, '--fetch'],
        env,
        Date.parse('2026-10-21T06:20:00Z'),
      )
      assert.deepEqual(
        [result.code, result.lines[0]],
        [2, 'APPWRITE_ENDPOINT has to be an https:// URL.'],
      )
    }
  })

  it('orders by $id with --order-by-id, and reads on past a page that ends at --from', async () => {
    // 100 account runs from --from on, so the first page's last run is at --from itself.
    const account = Array.from({ length: 100 }, (_, i) => ({
      ...run('00:00', { fn: 'account' }),
      $createdAt: new Date(Date.parse(FROM) + i * 60_000).toISOString().replace('Z', '+00:00'),
    }))
    const api = await serve({ runs: [...hourly('scheduler'), ...account], due: [], never: [] })
    try {
      await read(
        ['--from', FROM, '--fetch', '--order-by-id'],
        api.env,
        Date.parse('2026-10-21T06:20:00Z'),
      )
      const executions = api.requests.filter((r) => r.path.endsWith('/executions'))
      assert.ok(
        executions.every((r) =>
          r.queries.some((q) => q.method === 'orderDesc' && q.attribute === '$id'),
        ),
      )
      assert.equal(
        api.requests.filter((r) => r.path === '/v1/functions/account/executions').length,
        2,
      )
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
      assert.deepEqual(capped.lines.slice(3), [
        '',
        'Post on #96:',
        'capped groups: more than 2,000 runs since --from; read sooner',
      ])
      assert.equal(capped.code, 1)
      assert.equal(
        api.requests.filter((r) => r.path === '/v1/functions/groups/executions').length,
        20,
      )
    } finally {
      await api.close()
    }
  })
})
