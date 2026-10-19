import { Account, Client, Functions, TablesDB, Teams } from 'react-native-appwrite'

// Expo inlines only direct `process.env.EXPO_PUBLIC_*` reads.
export const client = new Client()
  .setEndpoint(process.env.EXPO_PUBLIC_APPWRITE_ENDPOINT ?? '')
  .setProject(process.env.EXPO_PUBLIC_APPWRITE_PROJECT_ID ?? '')
  // Expo Go's own identifier, registered on ledgerly-dev for the spike only (#57).
  .setPlatform('host.exp.exponent')

export const account = new Account(client)
export const functions = new Functions(client)
export const tablesDB = new TablesDB(client)
// Read only: the user's teams are the groups they have joined (D-004).
export const teams = new Teams(client)

export const DATABASE_ID = 'main'
