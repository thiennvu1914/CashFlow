import path from 'path'
import { loadEnvConfig } from '@next/env'
import { defineConfig, devices } from '@playwright/test'
import { assertE2eDatabaseUrl } from './lib/testing/e2e-database-url'

const outboxFile = path.resolve(__dirname, 'e2e/.outbox/emails.jsonl')

/**
 * Loads `.env*` into this process the way the `next dev` below will.
 *
 * The guard needs to compare `E2E_DATABASE_URL` against the app's REAL
 * `DATABASE_URL`, and `next dev` resolves that from four files in priority
 * order — `.env.development.local`, `.env.local`, `.env.development`, `.env`.
 * A plain `dotenv/config` reads only the last of them, so a `DATABASE_URL`
 * living in `.env.local` would be invisible here and visible to the server: the
 * same-database check would compare against the wrong value, or against nothing.
 * `@next/env` is the loader Next itself uses (the package its own docs point at
 * for "a root config file for an ORM or test runner"), so this cannot drift
 * from the server's view of the environment. `true` is its `dev` flag, matching
 * the `next dev` this config spawns.
 *
 * Like dotenv, it never overrides a variable that is already set, so an
 * exported shell value still wins and the guard stays fail-closed.
 */
loadEnvConfig(process.cwd(), true)
// `loadEnvConfig` stamps this internal marker on `process.env`, and
// `webServer.env` below spreads `process.env` into the spawned server — where
// its presence would make Next skip reading `.env*` at all and rely purely on
// what it inherited. Dropping it keeps that server's env loading exactly as it
// is when `npm run dev` is run by hand.
delete process.env.__NEXT_PROCESSED_ENV

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
    // The readiness probe, and it must stay a route that answers with the e2e
    // database still absent. Playwright starts this server BEFORE `globalSetup`
    // runs (see the comment on the guard above), so on a fresh clone this URL
    // is polled while `cashflow_e2e` has not been created yet — verified by
    // dropping the database and running the suite, which went green. `/login`
    // is a signed-out page whose chrome comes from the
    // `cashflow-theme`/`NEXT_LOCALE` cookies; pointing this at a route that
    // reads rows would risk deadlocking that first run.
    url: 'http://localhost:3000/login',
    // Never reuse a server this config did not start. A hand-started `npm run
    // dev` is on the app's own `DATABASE_URL` and has none of the variables
    // below, so reusing it would put every registration and every financial row
    // this suite writes into the development database — the exact defect the
    // guard above exists to prevent, reached around the side. With reuse off,
    // Playwright fails loudly when port 3000 is already busy, which is a
    // developer stopping their dev server rather than a silent wrong-database
    // run. The cost is one cold Turbopack compile per run, which
    // `e2e/helpers.ts`'s 30 s first-navigation allowance already covers.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      // The whole point of the guard: the server this suite drives writes its
      // throwaway users and financial rows into `E2E_DATABASE_URL`, never into
      // the developer's (or a deployment's) own database. Set explicitly rather
      // than inherited, so `next dev`'s own `.env` read cannot win — Next, like
      // dotenv, leaves an already-set variable alone.
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
