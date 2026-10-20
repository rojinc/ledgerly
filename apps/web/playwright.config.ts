import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const PORT = 5173

// Locally, the same `.env.local` as `npm run dev` (local-setup.md), so global setup sees the key
// too. Vite gives the browser only the VITE_ ones. In CI the workflow sets them instead.
const envFile = fileURLToPath(new URL('../../.env.local', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

/**
 * User flows 1–5 in a real browser (#38): a local Vite server pointed at the dev project by
 * VITE_APPWRITE_ENDPOINT and VITE_APPWRITE_PROJECT_ID, with users made through
 * E2E_APPWRITE_API_KEY (docs/engineering/testing.md#end-to-end).
 */
export default defineConfig({
  testDir: 'e2e',
  // Each flow's steps build on each other, in order; flows run side by side with their own users.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // One flow and every function call it makes; flow 5 alone waits up to a minute for a finalize.
  timeout: 3 * 60_000,
  // The whole suite, within #38's 10 minutes.
  globalTimeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // It returns the teardown, which deletes the run's users.
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Not the runner's zone, so a date that slips a day shows up.
    timezoneId: 'Australia/Sydney',
    locale: 'en-AU',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Always this checkout's code: a server already on the port (another worktree's) is an error.
    reuseExistingServer: false,
    // The server gets the runner's environment, but not the dev key: only the runner uses it.
    env: { E2E_APPWRITE_API_KEY: '' },
  },
})
