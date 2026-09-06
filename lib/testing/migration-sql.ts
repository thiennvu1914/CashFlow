import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = fileURLToPath(new URL('../../prisma/migrations', import.meta.url))

/**
 * Test-support helpers for asserting against the *real* migration SQL.
 *
 * The default taxonomy exists in exactly two places — the TypeScript constants
 * in `lib/server/defaults.ts` (the runtime seed) and the backfill migration's
 * VALUES lists (the one-off catch-up for users created before the seed hook).
 * Rather than copying the names a third time into a fixture, the tests read the
 * shipped `migration.sql` itself, so a name changed in only one of the two
 * places fails the suite instead of silently drifting.
 */
export function findMigrationSqlPath(suffix: string): string {
  const matches = readdirSync(migrationsDir).filter((entry) => entry.endsWith(`_${suffix}`))
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one migration directory ending in "_${suffix}", found ${matches.length}: ` +
        `${matches.join(', ') || '(none)'}`,
    )
  }
  return join(migrationsDir, matches[0], 'migration.sql')
}

export function readMigrationSql(suffix: string): string {
  return readFileSync(findMigrationSqlPath(suffix), 'utf8')
}

/**
 * Splits a migration file into executable statements.
 *
 * `prisma.$executeRawUnsafe` runs one statement per call, so the file has to be
 * broken up the same way the Prisma CLI does it. Line comments are dropped
 * first — this migration's SQL contains no string literal with a `--` or a `;`
 * in it, which is what makes that safe here.
 */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
