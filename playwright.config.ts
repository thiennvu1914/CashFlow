// First, and a side-effect import on purpose: `next dev` reads `.env` itself,
// but this process does not, so without it the database guard below would see
// neither `E2E_DATABASE_URL` nor `DATABASE_URL` unless they were exported in
// the shell. `dotenv/config` never overrides an already-set variable.
import 'dotenv/config'
import path from 'path'
import { defineConfig, devices } from '@playwright/test'
import { assertE2eDatabaseUrl } from './lib/testing/e2e-database-url'

const outboxFile = path.resolve(__dirname, 'e2e/.outbox/emails.jsonl')

/**
 * The database this suite is allowed to write to, or a throw that ends the run.
 *
 * Asserted HERE, while the config is being loaded, and not only in
 * `e2e/global-setup.ts`: Playwright starts the `webServer` BEFORE any global
 * setup hook — `createGlobalSetupTasks` in
 * `node_modules/playwright/lib/runner/index.js` puts `createPluginSetupTasks`
 * (which is what `webServer` is) ahead of every `globalSetup` file — so a check
 * that lived only in the hook would refuse *after* a dev server had already
 * been started against the wrong database. Throwing at config load means no
 * server, no browser and no test ever exists.
 *
 * `e2e/global-setup.ts` then creates and migrates it.
 */
const e2eDatabaseUrl = assertE2eDatabaseUrl(process.env)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'e2e/.results',
  globalSetup: './e2e/global-setup.ts',
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
      // The whole point of the guard: the server this suite drives writes its
      // throwaway users and financial rows into `E2E_DATABASE_URL`, never into
      // the developer's (or a deployment's) own database. Set explicitly rather
      // than inherited, so `next dev`'s own `.env` read cannot win — Next, like
      // dotenv, leaves an already-set variable alone.
      //
      // NOTE: `reuseExistingServer` is on outside CI, so a dev server started
      // by hand is used as-is and this override does not reach it. That server
      // is on `DATABASE_URL`; stop it before running the suite (the README says
      // the same thing about `EMAIL_OUTBOX_FILE`).
      DATABASE_URL: e2eDatabaseUrl,
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
