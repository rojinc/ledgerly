import { Account, Client, Functions } from 'appwrite'

export const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT)
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID)

export const account = new Account(client)
export const functions = new Functions(client)
