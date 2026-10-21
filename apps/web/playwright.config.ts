import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const PORT = 5173
const MOCK_PORT = 8790
// `npm run test:e2e:mock` (#554): the in-repo mock of the Appwrite API, never dev.
const mock = process.env.E2E_MOCK === '1'

if (mock) {
  // Set here, over anything in the environment, and `.env.local` isn't read: a mock run can't
  // reach dev. The key is the mock's own; it accepts any.
  process.env.VITE_APPWRITE_ENDPOINT = `http://localhost:${MOCK_PORT}/v1`
  process.env.VITE_APPWRITE_PROJECT_ID = 'mock-project'
  process.env.E2E_APPWRITE_API_KEY = 'mock-key'
} else {
  // Locally, the same `.env.local` as `npm run dev` (local-setup.md), so global setup sees the key
  // too. Vite gives the browser only the VITE_ ones. In CI the workflow sets them instead.
  const envFile = fileURLToPath(new URL('../../.env.local', import.meta.url))
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}

/**
 * User flows 1–10 (#38, #526), #512's flows and #525's in a real browser: a local Vite server
 * pointed at the dev project by VITE_APPWRITE_ENDPOINT and VITE_APPWRITE_PROJECT_ID, with users
 * made through E2E_APPWRITE_API_KEY (docs/engineering/testing.md#end-to-end), or at the mock.
 */
export default defineConfig({
  testDir: 'e2e',
  // Each flow's steps build on each other, in order; flows run side by side with their own users.
  fullyParallel: false,
  // One per flow file, set here: Playwright's default (half the CPUs) is 1 on a 2-vCPU runner, and
  // the flows back to back could outlast the 10 minutes before their afterEach archives run.
  workers: 15,
  forbidOnly: Boolean(process.env.CI),
  // One flow and every function call it makes; flows 5 and 8 wait up to a minute for a finalize.
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
  webServer: [
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      // Always this checkout's code: a server already on the port (another worktree's) is an error.
      reuseExistingServer: false,
      // The server gets the runner's environment, but not the dev key: only the runner uses it.
      env: { E2E_APPWRITE_API_KEY: '' },
    },
    ...(mock
      ? [
          {
            // packages/e2e-mock, built from this checkout by `npm run test:e2e:mock`. Its log
            // goes next to it, for the workflow to keep when a run fails.
            command: 'node ../../packages/e2e-mock/dist/server.mjs',
            url: `http://127.0.0.1:${MOCK_PORT}/v1/health`,
            reuseExistingServer: false,
            env: {
              MOCK_PORT: String(MOCK_PORT),
              MOCK_LOG: '../../packages/e2e-mock/dist/mock.log',
            },
          },
        ]
      : []),
  ],
})
