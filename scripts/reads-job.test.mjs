import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lastTo, main, runJob, stateLine, TITLE, withState } from './reads-job.mjs'

// The job at 08:37 UTC: its read ends 20 minutes earlier, and reaches back 23 hours at most.
const NOW = Date.parse('2026-11-05T08:37:00Z')
const TO = '2026-11-05T08:17:00Z'
const OLDEST = '2026-11-04T09:37:00Z'
const LAST = '2026-11-05T00:17:00Z'
const TOKEN = 'test-token-never-printed'
const KEY = 'test-key-never-printed'
const ENV = {
  READS_ISSUE: '581',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_TOKEN: TOKEN,
  GITHUB_API_URL: 'https://api.github.invalid',
  GITHUB_SERVER_URL: 'https://github.invalid',
  GITHUB_RUN_ID: '42',
  APPWRITE_ENDPOINT: 'https://appwrite.invalid/v1',
  APPWRITE_PROJECT_ID: 'ledgerly-test',
  APPWRITE_API_KEY: KEY,
}
const body = (to = LAST) =>
  `${stateLine({ to, nightly: 'PASS', errors: 'OK', at: '2026-11-05T00:37:00Z' })}\n\nWhat this is: the lead's text.`

// What reads.mjs prints, by exit code.
const OK = {
  lines: [
    'Post on #299:',
    `${LAST} → ${TO} · runs 8 … · overdue not read · PASS`,
    `errors ${LAST} → ${TO} · runs … · OK`,
  ],
  code: 0,
}
const LOOK = {
  lines: [
    'Post on #299:',
    `${LAST} → ${TO} · runs 8 … · overdue not read · PASS`,
    `errors ${LAST} → ${TO} · runs … · LOOK`,
    '',
    'Post on #96:',
    '1 run · ledger POST /transactions · 500 INTERNAL · first … last …',
  ],
  code: 1,
}
const FETCH_FAILED = { lines: ['FETCH FAILED scheduler at offset 0: 502 -'], code: 2 }
const TOO_EARLY = {
  lines: [
    "TOO EARLY: a run hasn't finished. Run it again in a few minutes, with the same --from.",
    'not ok run00001 …',
  ],
  code: 2,
}

/** A stand-in for GitHub's API: the reads issue, and every call made to it. */
function github({ issue = { title: TITLE, body: body() }, fail = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, redirect: init.redirect }
    if (init.body) call.body = JSON.parse(init.body).body
    calls.push(call)
    if (fail[init.method])
      return new Response('<html>secret page</html>', { status: fail[init.method] })
    return Response.json(init.method === 'GET' ? issue : {})
  }
  return { calls, fetchImpl }
}

/** The job with a stand-in read that answers `result`, and records how it was called. */
async function job(result, { env = ENV, gh = github(), now = NOW } = {}) {
  const reads = []
  const readImpl = async (args, readEnv, readNow) => {
    reads.push({ args, env: readEnv, now: readNow })
    if (result instanceof Error) throw result
    return result
  }
  const out = await runJob({ env, now, readImpl, fetchImpl: gh.fetchImpl })
  const by = (method) => gh.calls.filter((call) => call.method === method)
  return { ...out, reads, calls: gh.calls, comments: by('POST'), bodies: by('PATCH') }
}

describe('the state line', () => {
  it('reads back the `to` it wrote', () => {
    assert.equal(lastTo(body()), LAST)
  })

  it("reads nothing from a body without one, or one whose `to` isn't a time", () => {
    for (const text of [
      null,
      '',
      'Last read: none yet',
      'Last read: to 2026-11-05 · nightly PASS',
      'Last read: to 2026-13-45T99:99:99Z · nightly PASS · errors OK · at …',
      'Last read: to $(touch x) · nightly PASS',
    ]) {
      assert.equal(lastTo(text), undefined, text)
    }
  })

  it('replaces its line and keeps the rest of the body, `$` patterns included', () => {
    const line = stateLine({ to: TO, nightly: 'PASS', errors: 'OK', at: 'now' })
    assert.equal(
      withState(`${body()}\nCost: $& and $1.`, line),
      `${line}\n\nWhat this is: the lead's text.\nCost: $& and $1.`,
    )
    assert.equal(withState('The lead wrote this.', line), `${line}\n\nThe lead wrote this.`)
    assert.equal(withState(null, line), line)
  })
})

describe('a read', () => {
  it('reads from the last `to` to 20 minutes ago, without C, with only the Appwrite variables', async () => {
    const run = await job(OK)
    assert.deepEqual(run.reads, [
      {
        args: ['--from', LAST, '--to', TO, '--fetch', '--skip-overdue'],
        env: {
          APPWRITE_ENDPOINT: ENV.APPWRITE_ENDPOINT,
          APPWRITE_PROJECT_ID: ENV.APPWRITE_PROJECT_ID,
          APPWRITE_API_KEY: KEY,
        },
        now: NOW,
      },
    ])
  })

  it('that passes moves the state on and posts nothing', async () => {
    const run = await job(OK)
    assert.equal(run.code, 0)
    assert.equal(run.comments.length, 0)
    assert.deepEqual(
      run.bodies.map((call) => call.body),
      [
        `Last read: to ${TO} · nightly PASS · errors OK · at 2026-11-05T08:37:00Z\n\nWhat this is: the lead's text.`,
      ],
    )
  })

  it('that needs a look posts its lines, then moves the state on, and fails the run', async () => {
    const run = await job(LOOK)
    assert.equal(run.code, 1)
    assert.deepEqual(
      run.calls.map((call) => call.method),
      ['GET', 'POST', 'PATCH'],
    )
    const [comment] = run.comments
    assert.match(
      comment.body,
      /^\*\*Read `2026-11-05T00:17:00Z` → `2026-11-05T08:17:00Z`: needs a look\*\* \(\[run\]\(https:\/\/github\.invalid\/owner\/repo\/actions\/runs\/42\)\)/,
    )
    assert.ok(comment.body.includes('1 run · ledger POST /transactions · 500 INTERNAL'))
    assert.ok(!comment.body.includes('Post on #'))
    assert.match(run.bodies[0].body, / · errors LOOK · /)
  })

  for (const [what, result] of [
    ['a fetch that failed', FETCH_FAILED],
    ['a read that stopped', { lines: ['STOPPED: TypeError. Nothing to post: …'], code: 2 }],
  ]) {
    it(`posts ${what}, and keeps the state, so the next read covers the same window`, async () => {
      const run = await job(result)
      assert.equal(run.code, 1)
      assert.equal(run.bodies.length, 0)
      assert.match(run.comments[0].body, /: couldn't read\*\*/)
      assert.ok(run.comments[0].body.includes(result.lines[0]))
    })
  }

  it('posts its own error name when the read throws, and keeps the state', async () => {
    const error = new TypeError('a message quoting a reply')
    const run = await job(error)
    assert.equal(run.code, 1)
    assert.equal(run.bodies.length, 0)
    assert.ok(run.comments[0].body.includes('STOPPED: TypeError. Nothing was read.'))
    assert.ok(!run.comments[0].body.includes('a message quoting a reply'))
  })

  it("waits silently when it's too early once", async () => {
    const run = await job(TOO_EARLY)
    assert.equal(run.code, 0)
    assert.deepEqual(
      run.calls.map((call) => call.method),
      ['GET'],
    )
  })

  it('posts when the last read is over 16 hours old and a run is still waiting', async () => {
    const gh = github({ issue: { title: TITLE, body: body('2026-11-04T16:17:00Z') } })
    const run = await job(TOO_EARLY, { gh })
    assert.equal(run.code, 1)
    assert.equal(run.bodies.length, 0)
    assert.match(run.comments[0].body, /a run is still waiting, two reads running/)
  })

  it('says only that a run is still waiting when it posts for a gap, on the first read', async () => {
    const gh = github({ issue: { title: TITLE, body: "The lead's text only." } })
    const run = await job(TOO_EARLY, { gh })
    assert.equal(run.bodies.length, 0)
    assert.match(run.comments[0].body, /: a run is still waiting\*\*/)
    assert.ok(run.comments[0].body.includes("no last read in the issue's body"))
  })

  it('keeps only a verdict it knows in the state line, and `?` for anything else', async () => {
    const odd = { lines: ['Post on #299:', `${LAST} → ${TO} · PASS!`, `errors … · <b>`], code: 0 }
    const run = await job(odd)
    assert.match(run.bodies[0].body, / · nightly \? · errors \? · /)
  })

  it('links the run only from a GitHub server address and a run number', async () => {
    for (const env of [
      { ...ENV, GITHUB_SERVER_URL: 'https://github.invalid/x)[evil](https://evil.invalid' },
      { ...ENV, GITHUB_SERVER_URL: 'http://github.invalid' },
      { ...ENV, GITHUB_RUN_ID: '42)' },
    ]) {
      const run = await job(LOOK, { env })
      assert.match(run.comments[0].body, /: needs a look\*\*\n/)
      assert.ok(!run.comments[0].body.includes('[run]'))
    }
  })

  it('caps a long read under GitHub’s limit, and says how many lines are only in the log', async () => {
    const many = {
      ...LOOK,
      lines: [...LOOK.lines, ...Array.from({ length: 2000 }, (_, i) => `${'x'.repeat(60)} ${i}`)],
    }
    const run = await job(many)
    const comment = run.comments[0].body
    assert.ok(comment.length < 65_536, String(comment.length))
    assert.match(comment, /… \d+ more lines, in the run's log/)
  })

  it('has nothing to read when the last read ended 20 minutes ago or less', async () => {
    const gh = github({ issue: { title: TITLE, body: body(TO) } })
    const run = await job(OK, { gh })
    assert.equal(run.code, 0)
    assert.equal(run.reads.length, 0)
    assert.deepEqual(
      run.calls.map((call) => call.method),
      ['GET'],
    )
  })
})

describe('a gap', () => {
  for (const [what, text, says] of [
    [
      'over 23 hours old',
      body('2026-11-04T08:17:00Z'),
      'not read: 2026-11-04T08:17:00Z → 2026-11-04T09:37:00Z',
    ],
    ['missing', "The lead's text only.", "no last read in the issue's body"],
    ['in the future', body('2026-11-06T00:00:00Z'), "no last read in the issue's body"],
  ]) {
    it(`reads the last 23 hours when the last read is ${what}, and says so`, async () => {
      const gh = github({ issue: { title: TITLE, body: text } })
      const run = await job(OK, { gh })
      assert.equal(run.reads[0].args[1], OLDEST)
      assert.equal(run.code, 1)
      assert.ok(run.comments[0].body.includes(says), run.comments[0].body)
      assert.match(run.comments[0].body, /: read, but not from where the last one ended\*\*/)
      assert.match(run.bodies[0].body, new RegExp(`^Last read: to ${TO} · `))
    })
  }
})

describe('the issue', () => {
  it('is read and written only at READS_ISSUE, with the token in a header, never following a redirect', async () => {
    const run = await job(LOOK)
    for (const call of run.calls) {
      assert.match(
        call.url,
        /^https:\/\/api\.github\.invalid\/repos\/owner\/repo\/issues\/581(\/comments)?$/,
      )
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`)
      assert.equal(call.redirect, 'manual')
      assert.ok(!call.url.includes(TOKEN))
    }
  })

  for (const [what, issue] of [
    ['another title', { title: 'Something else', body: body() }],
    ['a pull request', { title: TITLE, body: body(), pull_request: {} }],
  ]) {
    it(`is left alone, with nothing read, when it has ${what}`, async () => {
      const gh = github({ issue })
      const run = await job(OK, { gh })
      assert.equal(run.code, 1)
      assert.equal(run.reads.length, 0)
      assert.deepEqual(
        gh.calls.map((call) => call.method),
        ['GET'],
      )
      assert.match(run.lines[0], /^STOPPED: #581 isn't the reads issue/)
    })
  }

  it('never puts its body in a comment or the log', async () => {
    const gh = github({ issue: { title: TITLE, body: `${body()}\nSECRET-BODY-TEXT` } })
    const run = await job(LOOK, { gh })
    assert.ok(!run.comments[0].body.includes('SECRET-BODY-TEXT'))
    assert.ok(!run.lines.join('\n').includes('SECRET-BODY-TEXT'))
  })

  it('stops before any call without its variables, or over plain HTTP', async () => {
    for (const env of [
      { ...ENV, READS_ISSUE: undefined },
      { ...ENV, READS_ISSUE: '581; rm -rf' },
      { ...ENV, GITHUB_REPOSITORY: 'owner/repo/../other' },
      { ...ENV, GITHUB_TOKEN: '' },
      { ...ENV, GITHUB_API_URL: 'http://api.github.invalid' },
    ]) {
      const gh = github()
      const run = await job(OK, { env, gh })
      assert.equal(run.code, 1)
      assert.equal(gh.calls.length, 0)
      assert.equal(run.reads.length, 0)
    }
  })

  it("leaves the state where it was when the comment can't be posted, and prints only the status", async () => {
    const gh = github({ fail: { POST: 403 } })
    const run = await job(LOOK, { gh })
    assert.equal(run.code, 1)
    assert.equal(run.bodies.length, 0)
    assert.equal(run.lines.at(-1), 'GITHUB FAILED commenting: 403')
    assert.ok(!run.lines.join('\n').includes('secret page'))
  })

  it("reads nothing when the issue can't be read", async () => {
    const gh = github({ fail: { GET: 404 } })
    const run = await job(OK, { gh })
    assert.equal(run.code, 1)
    assert.equal(run.reads.length, 0)
    assert.deepEqual(run.lines, ['GITHUB FAILED reading the issue: 404'])
  })
})

describe('the command', () => {
  it('prints the lines and returns the code', async () => {
    const printed = []
    const code = await main(
      async () => ({ lines: ['a', 'b'], code: 1 }),
      (text) => printed.push(text),
    )
    assert.equal(code, 1)
    assert.deepEqual(printed, ['a\nb'])
  })

  it("exits 1 with the error's name only when the job throws, so the run shows red", async () => {
    const printed = []
    const code = await main(
      async () => {
        throw new TypeError('a message quoting a reply')
      },
      (text) => printed.push(text),
    )
    assert.equal(code, 1)
    assert.deepEqual(printed, ['STOPPED: TypeError.'])
  })
})
