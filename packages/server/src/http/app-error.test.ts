import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AppError, ERROR_STATUS } from './app-error'

describe('AppError', () => {
  it('has every code and HTTP status from the Functions API doc, and no others', () => {
    const doc = readFileSync(
      new URL('../../../../docs/architecture/functions-api.md', import.meta.url),
      'utf8',
    )
    const documented = Object.fromEntries(
      [...doc.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \|/gm)].map(([, code, status]) => [
        code,
        Number(status),
      ]),
    )
    expect(Object.keys(documented)).toHaveLength(12)
    expect(ERROR_STATUS).toEqual(documented)
  })

  it('carries its code, message, details and status', () => {
    const error = new AppError('LOCKED', 'This transaction is on a final invoice.', { id: 't1' })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppError')
    expect(error.code).toBe('LOCKED')
    expect(error.message).toBe('This transaction is on a final invoice.')
    expect(error.details).toEqual({ id: 't1' })
    expect(error.status).toBe(409)
  })
})
