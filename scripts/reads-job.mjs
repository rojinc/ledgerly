// The reads job (docs/engineering/nightly-check.md#after-the-two-weeks, #568): after M4's two
// weeks, .github/workflows/reads.yml runs one read every 8 hours with `scripts/reads.mjs`, from
// where the last read ended, and posts on the reads issue when a read needs a look.
//   READS_ISSUE=<n> GITHUB_REPOSITORY=… GITHUB_TOKEN=… APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… \
//     APPWRITE_API_KEY=… node scripts/reads-job.mjs
// Its one input is that issue's body, which only collaborators can edit: never a comment, and never
// another issue. Like every Actions log here, its output is public, so it prints the read's own
// lines, the issue's number and times only: never the body, a reply or a key. It exits 1 when it
// posted or couldn't finish, so the run shows red, and 0 otherwise.
import { pathToFileURL } from 'node:url'
import { read, todate } from './reads.mjs'

/** The reads issue's title, checked before every write, so the job never acts on another issue. */
export const TITLE = 'Reads after M4'

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const HOUR = 3600
// Appwrite keeps a run's logs 24 hours on its Free plan, so a read reaches back 23 at most
// (nightly-check.md, how long the logs are kept).
const LONGEST = 23 * HOUR
// Two reads 8 hours apart that both found a run still waiting: it's stuck (error-lines.md).
const TOO_EARLY_TWICE = 16 * HOUR
const STATE = /^Last read: .*$/m
// The read's lines a comment holds, in characters, with room for the rest of it.
const COMMENT_LINES = 60_000
const NIGHTLY = /^(PASS|FAIL)$/
const ERRORS = /^(OK|LOOK|STUCK|INCOMPLETE|FETCH FAILED)$/

// An error's name or code, only when it looks like one, as log.ts's describe() does.
const name = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'Error'

/** The line the job keeps in the issue's body, and reads back at the next read. */
export const stateLine = ({ to, nightly, errors, at }) =>
  `Last read: to ${to} · nightly ${nightly} · errors ${errors} · at ${at}`

/** The last read's `to` from the issue's body: undefined when there's none, or it isn't a time. */
export function lastTo(body) {
  const to = /^Last read: to (\S+) · /m.exec(body ?? '')?.[1]
  return to !== undefined && TIME.test(to) && !Number.isNaN(Date.parse(to)) ? to : undefined
}

/** The body with its state line replaced, or added first. The rest stays as the lead wrote it. */
export function withState(body, line) {
  const text = body ?? ''
  // A function, so the line is never read as a replacement pattern (`$&` and the like).
  return STATE.test(text) ? text.replace(STATE, () => line) : `${line}\n\n${text}`.trimEnd()
}

class GitHubFailed extends Error {}

/** The reads issue through GitHub's REST API: read it, comment on it, and set its body. */
function issueApi({ api, repo, issue, token, fetchImpl }) {
  const base = `${api.replace(/\/$/, '')}/repos/${repo}/issues/${issue}`
  const call = async (what, method, path, body) => {
    let response
    try {
      response = await fetchImpl(base + path, {
        method,
        // Never followed: a redirect would carry the token to wherever it points.
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ledgerly-reads-job',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (error) {
      throw new GitHubFailed(`GITHUB FAILED ${what}: ${name(error?.cause?.code ?? error?.name)}`)
    }
    if (!response.ok) throw new GitHubFailed(`GITHUB FAILED ${what}: ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new GitHubFailed(`GITHUB FAILED ${what}: ${response.status} not JSON`)
    }
  }
  return {
    get: () => call('reading the issue', 'GET', ''),
    comment: (body) => call('commenting', 'POST', '/comments', { body }),
    setBody: (body) => call('writing the state line', 'PATCH', '', { body }),
  }
}

// The same rule as reads.mjs's for the key: HTTPS, or plain HTTP to this machine for the tests.
function httpsOrLoopback(value) {
  const url = URL.canParse(value) ? new URL(value) : undefined
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url?.hostname ?? '')
  return url?.protocol === 'https:' || (url?.protocol === 'http:' && local)
}

/** A verdict from the end of a result line, or `?`: the only text from it the body keeps. */
const verdict = (line, allowed) => {
  const word = (line ?? '').split(' · ').at(-1)
  return allowed.test(word) ? word : '?'
}

/** One run of the job: what to print, and the exit code. */
export async function runJob({
  env = process.env,
  now = Date.now(),
  readImpl = read,
  fetchImpl = fetch,
} = {}) {
  const { READS_ISSUE: issue, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = env
  const api = env.GITHUB_API_URL ?? 'https://api.github.com'
  if (!/^[1-9]\d{0,9}$/.test(issue ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !token) {
    return {
      lines: ['STOPPED: the job needs READS_ISSUE, GITHUB_REPOSITORY and GITHUB_TOKEN.'],
      code: 1,
    }
  }
  if (!httpsOrLoopback(api)) {
    return { lines: ['STOPPED: GITHUB_API_URL has to be an https:// URL.'], code: 1 }
  }
  const github = issueApi({ api, repo, issue, token, fetchImpl })
  const out = []
  let posted = false
  try {
    const current = await github.get()
    if (current?.title !== TITLE || current?.pull_request) {
      return { lines: [`STOPPED: #${issue} isn't the reads issue ("${TITLE}").`], code: 1 }
    }

    // From the last read's `to`, unless it's gone from the logs (or isn't a time we wrote).
    const to = todate(now / 1000 - 1200)
    const oldest = todate(now / 1000 - LONGEST)
    const last = lastTo(current.body)
    let from = last
    let gap
    if (last === undefined || last > to) {
      from = oldest
      gap = `no last read in the issue's body: this read starts at ${oldest}`
    } else if (last < oldest) {
      from = oldest
      gap = `not read: ${last} → ${oldest}, since Appwrite keeps a run's logs 24 hours`
    }
    if (from >= to) return { lines: [`Nothing to read: the last read ended at ${from}.`], code: 0 }

    // The Appwrite variables only: the read gets nothing else from the job's environment.
    const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = env
    let result
    try {
      result = await readImpl(
        ['--from', from, '--to', to, '--fetch', '--skip-overdue'],
        { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY },
        now,
      )
    } catch (error) {
      result = { lines: [`STOPPED: ${name(error?.name)}. Nothing was read.`], code: 2 }
    }
    out.push(...result.lines)

    const ran = result.code === 0 || result.code === 1
    const tooEarly = result.code === 2 && result.lines[0]?.startsWith('TOO EARLY')
    const stuck =
      tooEarly && last !== undefined && now / 1000 - Date.parse(last) / 1000 > TOO_EARLY_TWICE
    if (result.code === 1 || (result.code === 2 && !tooEarly) || stuck || gap) {
      const what =
        result.code === 0
          ? 'read, but not from where the last one ended'
          : result.code === 1
            ? 'needs a look'
            : tooEarly
              ? 'a run is still waiting, two reads running'
              : "couldn't read"
      const runUrl =
        /^https:\/\/[\w.-]+$/.test(env.GITHUB_SERVER_URL ?? '') &&
        /^\d+$/.test(env.GITHUB_RUN_ID ?? '')
          ? ` ([run](${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}))`
          : ''
      const lines = result.lines.filter((line) => !/^(Post on #(299|96):)?$/.test(line))
      // Under GitHub's 65,536 characters for a comment, so a long read still posts. The run's log
      // has every line.
      let shown = lines
      for (let size = 0, i = 0; i < lines.length; i++) {
        size += lines[i].length + 1
        if (size > COMMENT_LINES) {
          shown = lines.slice(0, i)
          break
        }
      }
      await github.comment(
        [
          `**Read \`${from}\` → \`${to}\`: ${what}**${runUrl}`,
          ...(gap ? ['', `- ${gap}`] : []),
          '',
          '```text',
          ...shown,
          ...(shown.length < lines.length
            ? [`… ${lines.length - shown.length} more lines, in the run's log`]
            : []),
          '```',
          '',
          '_The reads job (#568). The lead triages it by error-lines.md#the-verdict, and replies with what was done._',
        ].join('\n'),
      )
      posted = true
      out.push(`Posted on #${issue}.`)
    }
    // The state moves only after a read that ran, and after its comment: a failed post reads again.
    if (ran) {
      const line = stateLine({
        to,
        nightly: verdict(result.lines[1], NIGHTLY),
        errors: verdict(result.lines[2], ERRORS),
        at: todate(now / 1000),
      })
      await github.setBody(withState(current.body, line))
      out.push(`The last read now ends at ${to}.`)
    }
    return { lines: out, code: posted ? 1 : 0 }
  } catch (error) {
    if (error instanceof GitHubFailed) return { lines: [...out, error.message], code: 1 }
    throw error
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { lines, code } = await runJob()
    console.log(lines.join('\n'))
    process.exit(code)
  } catch (error) {
    // Its name only: a message or a stack could quote a reply.
    console.log(`STOPPED: ${name(error?.name)}.`)
    process.exit(1)
  }
}
