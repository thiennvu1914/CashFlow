import path from 'path'
import { defineConfig, devices } from '@playwright/test'

const outboxFile = path.resolve(__dirname, 'e2e/.outbox/emails.jsonl')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'e2e/.results',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      EMAIL_OUTBOX_FILE: outboxFile,
      SMTP_HOST: '',
      // The suite registers a brand-new user in almost every test across 12
      // spec files run sequentially (`workers: 1`), so several sign-ups can
      // land inside one 10s window. Better Auth's BUILT-IN special rule caps
      // `/sign-up/email` at 3 requests per 10s regardless of `customRules`
      // (see the comment on `rateLimit` in `lib/auth/create-auth.ts`), which
      // then 429s a registration and strands the test on `/register`. This
      // flag is read only by `lib/auth/create-auth.ts`, and only to disable
      // rate limiting for the server THIS config spawns — it is never set in
      // `.env*`, so `npm run dev` on its own and production are unaffected.
      CASHFLOW_E2E_DISABLE_RATE_LIMIT: '1',
    },
  },
})
