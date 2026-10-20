import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    // Playwright's: `npm run test:e2e` (docs/engineering/testing.md#end-to-end).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
