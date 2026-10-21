import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { followPageHeading } from './lib/page-heading'
import { routes } from './routes'
import './index.css'

const queryClient = new QueryClient()
const router = createBrowserRouter(routes)

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
followPageHeading(router, root)

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
