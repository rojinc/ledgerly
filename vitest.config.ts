import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each workspace is its own project, so `npm test` runs them all and
    // `npm test -w <workspace>` runs one.
    projects: ['apps/*', 'packages/*', 'functions/*'],
  },
})
