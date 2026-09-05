import { resolveTestDatabaseUrl } from './lib/testing/database-url'

/**
 * Runs in every Vitest worker, after `dotenv/config` has loaded `.env`.
 *
 * `lib/prisma.ts` builds its client from `DATABASE_URL`, so repointing that
 * variable here is what keeps every database-backed test on the dedicated
 * `cashflow_test` database instead of the developer's dev database.
 * `vitest.global-setup.ts` has already created and migrated it, and refuses to
 * start when the two URLs address the same database.
 */
process.env.DATABASE_URL = resolveTestDatabaseUrl(process.env)
