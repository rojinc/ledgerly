import { Account, Client, Functions, TablesDB } from 'appwrite'

export const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT)
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID)

export const account = new Account(client)
export const functions = new Functions(client)
export const tablesDB = new TablesDB(client)

// data-model.md: one database, `main`. Table IDs match appwrite/tables.json.
export const DATABASE_ID = 'main'
