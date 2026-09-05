import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors tsconfig.json's `@/*` path mapping — Vite/Vitest does not read
      // tsconfig `paths` on its own, so tests importing `@/...` (e.g. to
      // `vi.mock` an app module by its real import specifier) need this too.
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: [
      'lib/**/*.test.ts',
      'app/**/*.test.ts',
      'components/**/*.test.ts',
      'scripts/**/*.test.ts',
      'e2e-unit/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/.git/**', '.next/**', '.claude/**', 'docs/**', 'e2e/**'],
    // Creates and migrates the dedicated `cashflow_test` database once per run,
    // before any worker starts.
    globalSetup: ['./vitest.global-setup.ts'],
    // `dotenv/config` must stay first: `vitest.setup.ts` overrides the
    // `DATABASE_URL` it loads so no test can reach the development database.
    setupFiles: ['dotenv/config', './vitest.setup.ts'],
    // Database-backed tests share one database, and later phases share single
    // USD/VND FX cache rows. Running files sequentially keeps them from racing
    // each other over that shared state.
    fileParallelism: false,
  },
})
