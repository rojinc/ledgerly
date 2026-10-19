import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, expect, describe as group, it, type MockInstance, vi } from 'vitest'
import { EmailError } from '../email/send-email'
import { AppError } from './app-error'
import { describe, logProblem } from './log'

let logged: MockInstance<typeof console.error>
beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  logged.mockRestore()
  vi.unstubAllEnvs()
})

const lines = () => logged.mock.calls.map(([line]) => JSON.parse(String(line)))

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
    logProblem('claim_needs_merge')
    expect(lines()).toEqual([{ fn: 'unknown', event: 'claim_needs_merge' }])
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
    expect(String(logged.mock.calls)).not.toMatch(/sam|\$40/)
    expect(lines().map((line) => line.cause)).toEqual(['Error', 'string'])
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
    expect(describe(42)).toBe('number')
  })
})
