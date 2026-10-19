import { Account, Client, Functions, Realtime, Storage, TablesDB, Teams } from 'appwrite'

export const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT)
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID)

export const account = new Account(client)
export const functions = new Functions(client)
export const tablesDB = new TablesDB(client)
// Read only: the user's teams are the groups they have joined (D-004). Clients never change them.
export const teams = new Teams(client)
// One for the whole app: lib/realtime.ts subscribes while someone is signed in (#48).
export const realtime = new Realtime(client)
// Receipts (#162): files are uploaded here, then attached by the ledger function.
export const storage = new Storage(client)

// data-model.md: one database, `main`. Table IDs match appwrite/tables.json.
export const DATABASE_ID = 'main'
