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
    setupFiles: ['dotenv/config'],
  },
})
