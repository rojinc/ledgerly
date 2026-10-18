import type { RouteObject } from 'react-router'
import { HistoryPage } from './history-page'
import { NewTransactionPage } from './new-transaction-page'
import { TransactionPage } from './transaction-page'

/** `/transactions` and its pages, mounted with one line in src/routes.tsx. */
export const transactionRoutes: RouteObject = {
  path: 'transactions',
  children: [
    { index: true, element: <HistoryPage /> },
    { path: 'new', element: <NewTransactionPage /> },
    { path: ':transactionId', element: <TransactionPage /> },
  ],
}
