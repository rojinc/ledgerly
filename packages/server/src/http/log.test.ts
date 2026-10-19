import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, expect, describe as group, it, vi } from 'vitest'
import { EmailError } from '../email/send-email'
import { AppError } from './app-error'
import { describe, logProblem } from './log'

// Every line written, with the console method that wrote it.
let written: Array<{ level: string; line: string }>
beforeEach(() => {
  written = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      written.push({ level, line: String(line) })
    })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const lines = () => written.map(({ line }) => JSON.parse(line))
const levels = () => written.map(({ level }) => level)

group('logProblem', () => {
  it('writes one JSON line with the function, the event and the fields given', () => {
    vi.stubEnv('APPWRITE_FUNCTION_ID', 'statements')
    logProblem('snapshot_check_failed', { statementId: 'st1', problems: ['fresh', 'closing'] })
    logProblem('claim_identity_unusable', { identityType: 'phone' })
    logProblem('reminder_failed', {
      groupId: 'acme',
      transactionId: 't1',
      error: new TypeError('x'),
    })
    logProblem('summary_failed', { profileId: 'u1' })
    logProblem('typed_keys_deleted', { personId: 'p1', count: 2 })
    logProblem('person_reminder_failed', { reminderId: 'r1' })
    logProblem('nightly_check_finding', { groupId: 'elm', rule: 'I-3', transactionId: 't4' })
    logProblem('password_notice', { userId: 'u1', outcome: 'sent' })
    expect(lines()).toEqual([
      {
        fn: 'statements',
        event: 'snapshot_check_failed',
        statementId: 'st1',
        problems: ['fresh', 'closing'],
      },
      { fn: 'statements', event: 'claim_identity_unusable', identityType: 'phone' },
      {
        fn: 'statements',
        event: 'reminder_failed',
        groupId: 'acme',
        transactionId: 't1',
        cause: 'TypeError',
      },
      { fn: 'statements', event: 'summary_failed', profileId: 'u1' },
      { fn: 'statements', event: 'typed_keys_deleted', personId: 'p1', count: 2 },
      { fn: 'statements', event: 'person_reminder_failed', reminderId: 'r1' },
      {
        fn: 'statements',
        event: 'nightly_check_finding',
        groupId: 'elm',
        transactionId: 't4',
        rule: 'I-3',
      },
      { fn: 'statements', event: 'password_notice', userId: 'u1', outcome: 'sent' },
    ])
  })

  it('writes `unknown` for the function outside Appwrite', () => {
    logProblem('merge_member_dates_unreadable')
    expect(lines()).toEqual([{ fn: 'unknown', event: 'merge_member_dates_unreadable' }])
  })

  it('writes `invalid` for a value passed as an ID that isn’t one', () => {
    logProblem('draft_failed', {
      groupId: 'sam@example.com',
      statementId: 'Sam Smith',
      transactionId: '+61412345678',
      profileId: 'sam@example.com',
      personId: 'Sam Smith',
      reminderId: '+61412345678',
      userId: 'sam@example.com',
      membershipId: 'Sam Smith',
      scheduleId: 'sam@example.com',
    })
    expect(lines()).toEqual([
      {
        fn: 'unknown',
        event: 'draft_failed',
        groupId: 'invalid',
        statementId: 'invalid',
        transactionId: 'invalid',
        profileId: 'invalid',
        personId: 'invalid',
        reminderId: 'invalid',
        userId: 'invalid',
        membershipId: 'invalid',
        scheduleId: 'invalid',
      },
    ])
  })

  it('writes `invalid` for a count that isn’t a whole number of things', () => {
    for (const count of [0, 61412345678, -1, 1.5, Number.NaN, 2 ** 53]) {
      logProblem('pdf_characters_replaced', { count })
    }
    expect(lines().map((line) => line.count)).toEqual([
      0,
      61412345678,
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ])
  })

  it('never writes an error’s message', () => {
    logProblem('draft_failed', { groupId: 'g1', error: new Error('sam@example.com owes $40') })
    logProblem('draft_failed', { groupId: 'g1', error: 'sam@example.com' })
    expect(JSON.stringify(written)).not.toMatch(/sam|\$40/)
    expect(lines().map((line) => line.cause)).toEqual(['Error', 'string'])
  })

  it('writes each event at its level: problems as errors, the rest as logs or warnings', () => {
    logProblem('draft_failed', { groupId: 'g1' })
    logProblem('team_membership_removed', { groupId: 'g1', membershipId: 'm1' })
    logProblem('typed_keys_deleted', { personId: 'p1', count: 1 })
    logProblem('claim_identity_unusable', { identityType: 'phone' })
    logProblem('nightly_check_cut_off', { groupId: 'g1' })
    logProblem('pdf_characters_replaced', { count: 2 })
    for (const outcome of ['sent', 'stale', 'unverified', 'gone', 'failed'] as const) {
      logProblem('password_notice', { userId: 'u1', outcome })
    }
    // A merge (#242): what it did logs, what it left warns, what stops it is an error. The
    // hourly run's tally of merges (#246) logs.
    const merge = { personId: 'pP', intoPersonId: 'pU' }
    logProblem('merge_typed_keys_deleted', { ...merge, count: 1 })
    logProblem('merge_finished', merge)
    logProblem('merge_carries_on', merge)
    logProblem('merge_stopped_into_deleted', merge)
    logProblem('merge_left_transaction', { ...merge, transactionId: 't1' })
    logProblem('merge_left_locked_transaction', { ...merge, transactionId: 't1' })
    logProblem('merge_left_schedule', { ...merge, scheduleId: 's1' })
    logProblem('merge_left_stray_row', { ...merge, table: 'shares', rowId: 'r1' })
    logProblem('merge_left_subjects', { ...merge, groupId: 'g1', count: 2 })
    logProblem('merge_stopped', { intoPersonId: 'pU', error: new Error('x') })
    logProblem('merge_no_member_dates', { personId: 'pP', groupId: 'g1' })
    logProblem('merge_member_dates_unreadable', { personId: 'pP' })
    logProblem('merge_run', { counts: { unfinished: 1 } })
    expect(levels()).toEqual([
      'error',
      'error',
      'log',
      'warn',
      'warn',
      'warn',
      'log',
      'log',
      'log',
      'log',
      'error',
      'log',
      'log',
      'log',
      'log',
      'warn',
      'warn',
      'warn',
      'warn',
      'warn',
      'warn',
      'error',
      'error',
      'log',
    ])
    expect(lines()[1]).toEqual({
      fn: 'unknown',
      event: 'team_membership_removed',
      groupId: 'g1',
      membershipId: 'm1',
    })
  })

  it('writes counts by name, each a whole number, and no other key', () => {
    logProblem('merge_finished', {
      personId: 'pP',
      intoPersonId: 'Sam Smith',
      rowId: 'sam@example.com',
      counts: { groupsJoined: 2, shares: -1, identities: 1.5, inputs: 0 },
    })
    logProblem('merge_carries_on', {
      counts: { groupsPutOff: 1, ...({ name: 7 } as Record<string, number>) },
    })
    logProblem('merge_run', {
      counts: { personsRead: 3, cutOff: 1, skipped: 0, finished: 1, unfinished: 2 },
    })
    expect(lines()).toEqual([
      {
        fn: 'unknown',
        event: 'merge_finished',
        personId: 'pP',
        intoPersonId: 'invalid',
        rowId: 'invalid',
        counts: { groupsJoined: 2, inputs: 0, shares: 'invalid', identities: 'invalid' },
      },
      { fn: 'unknown', event: 'merge_carries_on', counts: { groupsPutOff: 1 } },
      {
        fn: 'unknown',
        event: 'merge_run',
        counts: { unfinished: 2, finished: 1, skipped: 0, cutOff: 1, personsRead: 3 },
      },
    ])
  })

  it('names an error that is undefined', () => {
    logProblem('draft_failed', { groupId: 'g1', error: undefined })
    expect(lines()[0]?.cause).toBe('undefined')
  })
})

group('describe', () => {
  it('names each kind of error by its code or type, never its message', () => {
    expect(describe(new AppError('CONFLICT', 'Sam changed it'))).toBe('AppError CONFLICT')
    expect(describe(new AppwriteException('Row x', 404, 'row_not_found'))).toBe(
      'AppwriteException 404 row_not_found',
    )
    expect(describe(new EmailError('to sam@example.com', 'validation_error', 422))).toBe(
      'EmailError validation_error 422',
    )
    expect(describe(new EmailError('no key', 'missing_config'))).toBe('EmailError missing_config')
    expect(describe(new SyntaxError('Unexpected token S in "Sam"'))).toBe('SyntaxError')
    // A name or type is any code's to set, so one that isn't shaped like one isn't written.
    const named = new Error('x')
    named.name = 'sam@example.com'
    expect(describe(named)).toBe('invalid')
    expect(describe(new AppwriteException('x', 400, 'Sam Smith'))).toBe(
      'AppwriteException 400 invalid',
    )
    // A reply that isn't JSON has no type.
    expect(describe(new AppwriteException('Bad gateway', 502, ''))).toBe('AppwriteException 502')
    expect(describe(42)).toBe('number')
  })
})
