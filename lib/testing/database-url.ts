/**
 * Pure connection-string helpers for the Vitest database plumbing.
 *
 * Deliberately dependency-free — no `pg`, no `node:child_process` — so it can
 * be imported by `vitest.setup.ts` (which runs inside every worker) and unit
 * tested on its own. The side-effecting work lives in `vitest.global-setup.ts`.
 */

/**
 * Fallback when `TEST_DATABASE_URL` is unset. Same credentials and port as the
 * `docker compose` Postgres in `docker-compose.yml`, but a separate database.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://cashflow:cashflow_dev_password@localhost:5439/cashflow_test'

/** Postgres' own default port, used when a connection string omits one. */
const DEFAULT_POSTGRES_PORT = '5432'

/** Prisma's default schema, used when a connection string omits `?schema=`. */
const DEFAULT_SCHEMA = 'public'

/**
 * The test database URL, with the default applied. Typed as a plain string map
 * rather than `NodeJS.ProcessEnv` — Next's type augmentation makes `NODE_ENV`
 * required there, which would force every test to supply it — so callers can
 * pass `process.env` or a one-key literal.
 */
export function resolveTestDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  return env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL
}

/**
 * `new URL`, but the failure message names the environment variable instead of
 * echoing the value — a connection string carries a password.
 */
export function parseConnectionString(value: string, variableName: string): URL {
  try {
    return new URL(value)
  } catch (cause) {
    throw new Error(`${variableName} is not a valid connection string.`, { cause })
  }
}

/** The database a connection string points at, i.e. its path segment. */
export function databaseNameOf(connectionString: string, variableName: string): string {
  return decodeURIComponent(
    parseConnectionString(connectionString, variableName).pathname.replace(/^\//, ''),
  )
}

/**
 * A database name safe to interpolate into `CREATE DATABASE`. SQL has no bind
 * parameters for identifiers, so anything but a plain identifier is refused
 * outright rather than quoted and hoped for.
 */
export function assertCreatableDatabaseName(name: string, variableName: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `${variableName} must name a database matching /^[A-Za-z0-9_]+$/; got ${JSON.stringify(name)}.`,
    )
  }
  return name
}

/**
 * Every spelling of "this machine". `URL#hostname` strips the brackets from
 * an IPv6 literal, so `[::1]` arrives here as `::1`; both forms are listed
 * anyway so a caller comparing raw strings gets the same answer.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * A hostname reduced to one canonical form per physical server.
 *
 * `localhost`, `127.0.0.1` and `::1` all reach the same Postgres, so treating
 * them as three different hosts would let a development URL written one way
 * and a test URL written another slip past `isSameDatabase` — exactly the
 * guard that keeps `vitest` from migrating and truncating the developer's own
 * database.
 */
function canonicalHostname(hostname: string): string {
  const lower = hostname.toLowerCase()
  return LOOPBACK_HOSTNAMES.has(lower) ? 'localhost' : lower
}

interface DatabaseIdentity {
  hostname: string
  port: string
  database: string
  schema: string
}

function identify(url: URL): DatabaseIdentity {
  return {
    hostname: canonicalHostname(url.hostname),
    port: url.port || DEFAULT_POSTGRES_PORT,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    schema: url.searchParams.get('schema') || DEFAULT_SCHEMA,
  }
}

/**
 * Whether two connection strings address the same physical database.
 *
 * A plain string comparison is not enough to keep the test suite off the
 * development database: `…/cashflow?schema=public` and `…/cashflow` are the
 * same database written two ways, as are an omitted port and an explicit 5432.
 * Credentials are ignored on purpose — signing in as a different role does not
 * make it a different database.
 *
 * Falls back to an exact comparison when either side will not parse, so an
 * unparseable pair still cannot slip past the guard.
 */
export function isSameDatabase(a: string, b: string): boolean {
  let first: DatabaseIdentity
  let second: DatabaseIdentity
  try {
    first = identify(new URL(a))
    second = identify(new URL(b))
  } catch {
    return a === b
  }
  return (
    first.hostname === second.hostname &&
    first.port === second.port &&
    first.database === second.database &&
    first.schema === second.schema
  )
}

/**
 * Connection strings to try, in order, for the `CREATE DATABASE` that prepares
 * the test database.
 *
 * `CREATE DATABASE` has to be issued from some other database on the SAME
 * server as the one being created, so the first candidate is always the test
 * server with the maintenance database `postgres` — never the developer's
 * `DATABASE_URL`, which may well point at a different host.
 *
 * The dev URL is offered as a second attempt only when it is on that same host
 * and port, covering a server whose `postgres` maintenance database has been
 * removed but whose dev database is reachable.
 *
 * `variableName` names the variable `testDatabaseUrl` came from, the way every
 * other function here takes it: this is shared by the Vitest
 * (`TEST_DATABASE_URL`) and Playwright (`E2E_DATABASE_URL`) paths, so a
 * hard-coded name would send the e2e caller's reader to the wrong variable.
 */
export function adminConnectionCandidates(
  testDatabaseUrl: string,
  devDatabaseUrl: string | undefined,
  variableName: string,
): string[] {
  const test = parseConnectionString(testDatabaseUrl, variableName)

  const maintenance = new URL(test.toString())
  maintenance.pathname = '/postgres'
  // `?schema=` is Prisma's, not Postgres', and means nothing for a bare
  // `CREATE DATABASE` connection.
  maintenance.search = ''
  const candidates = [maintenance.toString()]

  if (!devDatabaseUrl) return candidates
  const dev = parseConnectionString(devDatabaseUrl, 'DATABASE_URL')
  const sameServer =
    canonicalHostname(dev.hostname) === canonicalHostname(test.hostname) &&
    (dev.port || DEFAULT_POSTGRES_PORT) === (test.port || DEFAULT_POSTGRES_PORT)
  if (sameServer) candidates.push(devDatabaseUrl)
  return candidates
}
