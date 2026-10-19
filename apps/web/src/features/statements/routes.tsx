import type { RouteObject } from 'react-router'
import { StatementPage } from './statement-page'
import { StatementsPage } from './statements-page'

/**
 * `/groups/{groupId}/statements` and one statement, mounted with one line in src/routes.tsx.
 * The draft email links to a statement here (statements.md#1-draft-statements-job-hourly).
 */
export const statementRoutes: RouteObject = {
  path: 'groups/:groupId/statements',
  children: [
    { index: true, element: <StatementsPage /> },
    { path: ':statementId', element: <StatementPage /> },
  ],
}
