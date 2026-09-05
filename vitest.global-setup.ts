import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { Client } from 'pg'
import {
  adminConnectionCandidates,
  assertCreatableDatabaseName,
  databaseNameOf,
  isSameDatabase,
  parseConnectionString,
  resolveTestDatabaseUrl,
} from './lib/testing/database-url'

const repoRoot = new URL('.', import.meta.url)

/**
 * Creates the test database if it is missing, using the first admin connection
 * that answers. Every candidate is on the test server, so nothing here can
 * reach a different host than the one the tests will use.
 */
async function createTestDatabaseIfMissing(
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

function migrateTestDatabase(testDatabaseUrl: string): void {
  // Invoked through `process.execPath` rather than `npx`: since Node 20.12 a
  // `.cmd` shim (which is what `npx` is on Windows) cannot be spawned without
  // `shell: true`, and running the locally installed CLI directly also pins the
  // version to the one in `package.json`.
  const prismaCli = fileURLToPath(new URL('node_modules/prisma/build/index.js', repoRoot))
  if (!existsSync(prismaCli)) {
    throw new Error(`Prisma CLI not found at ${prismaCli}. Run \`npm install\` first.`)
  }
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: fileURLToPath(repoRoot),
      // `prisma7.config.ts` reads DATABASE_URL, and its `dotenv/config` import
      // never overrides an already-set variable — so this points the CLI at the
      // test database without touching `.env`.
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      // Piped, not inherited, so a successful run adds nothing to the Vitest
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

/**
 * Creates and migrates the dedicated Vitest database before any test file runs.
 *
 * Tests must never touch the development database: they write throwaway users,
 * FX rates and transactions, and those would otherwise show up in real dev
 * usage. `vitest.setup.ts` repoints `DATABASE_URL` inside every worker, and
 * this hook makes sure the database that points at actually exists and carries
 * the current migrations.
 */
export async function setup(): Promise<void> {
  loadEnv()

  const testDatabaseUrl = resolveTestDatabaseUrl(process.env)
  const devDatabaseUrl = process.env.DATABASE_URL?.trim() || undefined
  const testUrl = parseConnectionString(testDatabaseUrl, 'TEST_DATABASE_URL')

  if (devDatabaseUrl && isSameDatabase(devDatabaseUrl, testDatabaseUrl)) {
    throw new Error(
      'TEST_DATABASE_URL and DATABASE_URL address the same database. The test suite truncates ' +
        'and rewrites whatever it connects to, so it must never run against the development ' +
        'database. Point TEST_DATABASE_URL at a separate database (e.g. cashflow_test).',
    )
  }

  const databaseName = assertCreatableDatabaseName(
    databaseNameOf(testDatabaseUrl, 'TEST_DATABASE_URL'),
    'TEST_DATABASE_URL',
  )
  await createTestDatabaseIfMissing(
    adminConnectionCandidates(testDatabaseUrl, devDatabaseUrl),
    databaseName,
    testUrl.host,
  )
  migrateTestDatabase(testDatabaseUrl)

  // Workers are forked after this hook returns, so they inherit the resolved
  // value even when `.env` did not define it.
  process.env.TEST_DATABASE_URL = testDatabaseUrl
}
