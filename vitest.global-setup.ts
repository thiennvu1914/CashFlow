import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { isSameDatabase, resolveTestDatabaseUrl } from './lib/testing/database-url'
import { prepareDatabase } from './lib/testing/prepare-database'

const repoRoot = new URL('.', import.meta.url)

/**
 * Creates and migrates the dedicated Vitest database before any test file runs.
 *
 * Tests must never touch the development database: they write throwaway users,
 * FX rates and transactions, and those would otherwise show up in real dev
 * usage. `vitest.setup.ts` repoints `DATABASE_URL` inside every worker, and
 * this hook makes sure the database that points at actually exists and carries
 * the current migrations.
 *
 * The create-and-migrate half lives in `lib/testing/prepare-database.ts`, which
 * `e2e/global-setup.ts` uses for `cashflow_e2e` too — same code, same failure
 * messages, one place to fix.
 */
export async function setup(): Promise<void> {
  loadEnv()

  const testDatabaseUrl = resolveTestDatabaseUrl(process.env)
  const devDatabaseUrl = process.env.DATABASE_URL?.trim() || undefined

  if (devDatabaseUrl && isSameDatabase(devDatabaseUrl, testDatabaseUrl)) {
    throw new Error(
      'TEST_DATABASE_URL and DATABASE_URL address the same database. The test suite truncates ' +
        'and rewrites whatever it connects to, so it must never run against the development ' +
        'database. Point TEST_DATABASE_URL at a separate database (e.g. cashflow_test).',
    )
  }

  await prepareDatabase({
    databaseUrl: testDatabaseUrl,
    variableName: 'TEST_DATABASE_URL',
    repoRoot: fileURLToPath(repoRoot),
    peerDatabaseUrl: devDatabaseUrl,
  })

  // Workers are forked after this hook returns, so they inherit the resolved
  // value even when `.env` did not define it.
  process.env.TEST_DATABASE_URL = testDatabaseUrl
}
