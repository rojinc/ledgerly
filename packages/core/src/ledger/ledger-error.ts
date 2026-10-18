/**
 * A broken ledger rule. Functions turn `code` into the error envelope
 * (functions-api.md#response-envelope): VALIDATION_FAILED for bad input,
 * INVARIANT_VIOLATION for a bug that would corrupt the ledger.
 */
export class LedgerError extends Error {
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'INVARIANT_VIOLATION',
    message: string,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

export function invalid(message: string): never {
  throw new LedgerError('VALIDATION_FAILED', message)
}
