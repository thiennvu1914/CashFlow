import { defineConfig } from 'vitest/config'

export default defineConfig({
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
