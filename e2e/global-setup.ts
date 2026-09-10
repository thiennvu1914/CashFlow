import path from 'path'
import { config as loadEnv } from 'dotenv'
import { E2E_DATABASE_URL_VARIABLE, assertE2eDatabaseUrl } from '../lib/testing/e2e-database-url'
import { prepareDatabase } from '../lib/testing/prepare-database'

/**
 * Creates and migrates the dedicated Playwright database before any test runs —
 * the same shape, and the same code, as `vitest.global-setup.ts`.
 *
 * The REFUSAL half of the guard is not here. `playwright.config.ts` evaluates
 * `assertE2eDatabaseUrl` while it is being loaded, because Playwright starts
 * the `webServer` before it runs any global setup hook (see the comment there);
 * by the time this file runs, a dev server is already up. The assertion is
 * repeated here anyway so this hook can never prepare a database the policy
 * would have refused — it is the same pure decision, so it either agrees with
 * the config or the run is already over.
 */
export default async function globalSetup(): Promise<void> {
  // `next dev` loads `.env` itself, but this process does not: without it both
  // `E2E_DATABASE_URL` and `DATABASE_URL` would look unset to the guard unless
  // they happened to be exported in the shell. Never overrides an
  // already-exported value.
  loadEnv()

  const e2eDatabaseUrl = assertE2eDatabaseUrl(process.env)

  await prepareDatabase({
    databaseUrl: e2eDatabaseUrl,
    variableName: E2E_DATABASE_URL_VARIABLE,
    repoRoot: path.resolve(__dirname, '..'),
    peerDatabaseUrl: process.env.DATABASE_URL?.trim() || undefined,
  })
}
