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
    // `.tsx` mirrors every `.ts` glob: a component test has to be written in
    // `.tsx` to contain JSX, and without these patterns such a file would be
    // silently skipped — a green run that never executed it.
    include: [
      'lib/**/*.test.ts',
      'lib/**/*.test.tsx',
      'app/**/*.test.ts',
      'app/**/*.test.tsx',
      'components/**/*.test.ts',
      'components/**/*.test.tsx',
      'scripts/**/*.test.ts',
      'scripts/**/*.test.tsx',
      'e2e-unit/**/*.test.ts',
      'e2e-unit/**/*.test.tsx',
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
