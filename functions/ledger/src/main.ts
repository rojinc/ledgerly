import { createHandler, route } from '@ledgerly/server/http/create-handler'
import { createTransaction } from './routes/transactions-create'
import { postTransaction } from './routes/transactions-post'
import { updateTransaction } from './routes/transactions-update'
import { voidTransaction } from './routes/transactions-void'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

export default createHandler([
  route('GET', '/health', async () => ({ fn: 'ledger', version }), { public: true }),
  createTransaction,
  updateTransaction,
  postTransaction,
  voidTransaction,
])
