import type { RouteObject } from 'react-router'
import { BillPage, NewBillPage } from './bill-page'
import { BillsPage } from './bills-page'

/** `/bills`, a new bill and one bill, mounted with one line in src/routes.tsx (#75). */
export const billRoutes: RouteObject = {
  path: 'bills',
  children: [
    { index: true, element: <BillsPage /> },
    { path: 'new', element: <NewBillPage /> },
    { path: ':billId', element: <BillPage /> },
  ],
}
