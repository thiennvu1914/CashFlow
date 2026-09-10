import path from 'path'
import { loadEnvConfig } from '@next/env'
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
  // The same loader, the same `dev` flag and therefore the same file
  // precedence as `playwright.config.ts` — the two halves of one guard must
  // never disagree about what the environment says. Redundant when this hook
  // runs in the process that already loaded the config, and load-bearing when
  // it does not; either way it never overrides an already-set value.
  loadEnvConfig(process.cwd(), true)

  const e2eDatabaseUrl = assertE2eDatabaseUrl(process.env)

  await prepareDatabase({
    databaseUrl: e2eDatabaseUrl,
    variableName: E2E_DATABASE_URL_VARIABLE,
    repoRoot: path.resolve(__dirname, '..'),
    peerDatabaseUrl: process.env.DATABASE_URL?.trim() || undefined,
  })
}
