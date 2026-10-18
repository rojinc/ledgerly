import { createHandler, type Route, route } from '@ledgerly/server/http/create-handler'
import { groupBalances } from './routes/balances'
import { startTimer } from './routes/timer-start'
import { stopTimer } from './routes/timer-stop'
import { createTransaction } from './routes/transactions-create'
import { postTransaction } from './routes/transactions-post'
import { updateTransaction } from './routes/transactions-update'
import { voidTransaction } from './routes/transactions-void'
import { type ServicesFor, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The ledger routes (functions-api.md#ledger). Tests pass fake services. */
export function ledgerRoutes(services: ServicesFor): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'ledger', version }), { public: true }),
    createTransaction(services),
    updateTransaction(services),
    postTransaction(services),
    voidTransaction(services),
    startTimer(services),
    stopTimer(services),
    groupBalances(services),
  ]
}

export default createHandler(ledgerRoutes(servicesFromRequest))
