import { createHandler, route } from '@ledgerly/server/http/create-handler'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

export default createHandler([route('GET', '/health', async () => ({ fn: 'groups', version }))])
