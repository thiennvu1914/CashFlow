import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { Client } from 'pg'

/**
 * Fallback when `TEST_DATABASE_URL` is unset. Same credentials and port as the
 * `docker compose` Postgres in `docker-compose.yml`, but a separate database.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://cashflow:cashflow_dev_password@localhost:5439/cashflow_test'

/** The test database URL, with the default applied. Shared with `vitest.setup.ts`. */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL
}

const repoRoot = new URL('.', import.meta.url)

function databaseNameOf(connectionString: string): string {
  const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''))
  // The name is interpolated into `CREATE DATABASE` — no bind parameters exist
  // for identifiers — so anything but a plain identifier is refused outright
  // rather than quoted and hoped for.
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL must name a database matching /^[A-Za-z0-9_]+$/; got ${JSON.stringify(name)}.`,
    )
  }
  return name
}

/**
 * Connection used only to issue `CREATE DATABASE`: the dev database from
 * `DATABASE_URL` when there is one, otherwise `postgres` on the test server.
 */
function adminConnectionString(
  testDatabaseUrl: string,
  devDatabaseUrl: string | undefined,
): string {
  if (devDatabaseUrl) return devDatabaseUrl
  const url = new URL(testDatabaseUrl)
  url.pathname = '/postgres'
  return url.toString()
}

async function createTestDatabaseIfMissing(
  adminUrl: string,
  databaseName: string,
  testDatabaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: adminUrl })
  try {
    await client.connect()
  } catch (cause) {
    throw new Error(
      `Cannot reach PostgreSQL at ${new URL(testDatabaseUrl).host} to prepare the test database ` +
        `"${databaseName}". Start it with \`docker compose up -d\` and run the tests again.`,
      { cause },
    )
  }
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ])
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await client.end()
  }
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
  const devDatabaseUrl = process.env.DATABASE_URL?.trim()

  if (devDatabaseUrl && devDatabaseUrl === testDatabaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is identical to DATABASE_URL. The test suite truncates and rewrites ' +
        'whatever it connects to, so it must never run against the development database. ' +
        'Point TEST_DATABASE_URL at a separate database (e.g. cashflow_test).',
    )
  }

  const databaseName = databaseNameOf(testDatabaseUrl)
  await createTestDatabaseIfMissing(
    adminConnectionString(testDatabaseUrl, devDatabaseUrl),
    databaseName,
    testDatabaseUrl,
  )
  migrateTestDatabase(testDatabaseUrl)

  // Workers are forked after this hook returns, so they inherit the resolved
  // value even when `.env` did not define it.
  process.env.TEST_DATABASE_URL = testDatabaseUrl
}
