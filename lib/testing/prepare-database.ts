/**
 * Creating and migrating a throwaway test database.
 *
 * Extracted from `vitest.global-setup.ts` so the Playwright suite's own guard
 * (`e2e/global-setup.ts`) prepares `cashflow_e2e` through exactly the same code
 * that prepares `cashflow_test` — a second copy of this is how the two would
 * drift, and the one in the Vitest path is the proven one.
 *
 * `repoRoot` is a parameter rather than something this module derives from
 * `import.meta.url`: Vitest loads this file as an ES module, Playwright
 * transforms it to CommonJS (where `import.meta` does not exist), so the only
 * spelling that works in both runners is the caller's own.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import {
  adminConnectionCandidates,
  assertCreatableDatabaseName,
  databaseNameOf,
  parseConnectionString,
} from './database-url'

/**
 * Creates the database if it is missing, using the first admin connection that
 * answers. Every candidate is on the same server as the database being created,
 * so nothing here can reach a different host than the one the tests will use.
 */
async function createDatabaseIfMissing(
  candidates: string[],
  databaseName: string,
  serverLabel: string,
): Promise<void> {
  const failures: unknown[] = []

  for (const connectionString of candidates) {
    const client = new Client({ connectionString })
    try {
      await client.connect()
    } catch (cause) {
      failures.push(cause)
      continue
    }
    try {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        databaseName,
      ])
      if (existing.rowCount === 0) await client.query(`CREATE DATABASE "${databaseName}"`)
      return
    } finally {
      await client.end()
    }
  }

  throw new Error(
    `Cannot reach PostgreSQL at ${serverLabel} to prepare the test database "${databaseName}". ` +
      'Start it with `docker compose up -d` and run the tests again.',
    { cause: failures[0] },
  )
}

function migrate(databaseUrl: string, repoRoot: string): void {
  // Invoked through `process.execPath` rather than `npx`: since Node 20.12 a
  // `.cmd` shim (which is what `npx` is on Windows) cannot be spawned without
  // `shell: true`, and running the locally installed CLI directly also pins the
  // version to the one in `package.json`.
  const prismaCli = path.join(repoRoot, 'node_modules/prisma/build/index.js')
  if (!existsSync(prismaCli)) {
    throw new Error(`Prisma CLI not found at ${prismaCli}. Run \`npm install\` first.`)
  }
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: repoRoot,
      // `prisma7.config.ts` reads DATABASE_URL, and its `dotenv/config` import
      // never overrides an already-set variable — so this points the CLI at the
      // test database without touching `.env`.
      env: { ...process.env, DATABASE_URL: databaseUrl },
      // Piped, not inherited, so a successful run adds nothing to the runner's
      // output; the captured text is replayed only when the CLI fails.
      stdio: 'pipe',
    })
  } catch (cause) {
    const output = cause instanceof Error && 'stderr' in cause ? String(cause.stderr) : ''
    throw new Error(`\`prisma migrate deploy\` failed against the test database.\n${output}`, {
      cause,
    })
  }
}

export interface PrepareDatabaseOptions {
  /** The database to create and migrate. */
  databaseUrl: string
  /** Which environment variable `databaseUrl` came from, for error messages. */
  variableName: string
  /** Absolute path to the repository root — where `node_modules/prisma` lives. */
  repoRoot: string
  /**
   * A connection string that may be on the same server, offered as a second
   * admin candidate for the `CREATE DATABASE` (see
   * `adminConnectionCandidates`). Normally the developer's `DATABASE_URL`.
   */
  peerDatabaseUrl?: string
}

/**
 * Creates the database `databaseUrl` names if it does not exist yet, then
 * brings it up to the current migrations. Idempotent: on every run after the
 * first, `CREATE DATABASE` is skipped and `prisma migrate deploy` is a no-op.
 *
 * This function does NOT decide whether `databaseUrl` is safe to write to —
 * that is the caller's guard (`vitest.global-setup.ts`,
 * `lib/testing/e2e-database-url.ts`), and it must run first.
 */
export async function prepareDatabase(options: PrepareDatabaseOptions): Promise<void> {
  const { databaseUrl, variableName, repoRoot, peerDatabaseUrl } = options
  const url = parseConnectionString(databaseUrl, variableName)
  const databaseName = assertCreatableDatabaseName(
    databaseNameOf(databaseUrl, variableName),
    variableName,
  )

  await createDatabaseIfMissing(
    adminConnectionCandidates(databaseUrl, peerDatabaseUrl, variableName),
    databaseName,
    url.host,
  )
  migrate(databaseUrl, repoRoot)
}
