/**
 * The fail-closed decision that keeps the Playwright suite off any database it
 * must not write to.
 *
 * The browser suite is not a read-only observer: `e2e/helpers.ts` registers a
 * real user in almost every spec file and then creates accounts, transactions,
 * transfers, budgets, goals, debts, loans and reminders through the real UI,
 * and nothing deletes any of it afterwards. Before this guard the spawned dev
 * server inherited `DATABASE_URL`, so `npm run test:e2e` wrote all of that into
 * the developer's own database — and, with a production `DATABASE_URL` in the
 * environment, into production.
 *
 * Deliberately dependency-free and side-effect-free — no `pg`, no
 * `node:child_process`, no reads of `process.env` of its own — so it can be
 * evaluated while `playwright.config.ts` is still being loaded (before any
 * server is spawned) and unit tested on its own. The side-effecting half lives
 * in `lib/testing/prepare-database.ts`.
 */

import {
  assertCreatableDatabaseName,
  databaseNameOf,
  isSameDatabase,
  parseConnectionString,
} from './database-url'

/** The variable the whole guard is about, named once. */
export const E2E_DATABASE_URL_VARIABLE = 'E2E_DATABASE_URL'

/**
 * The name of a database this suite is allowed to create, migrate and fill with
 * throwaway rows must say so: it has to carry `e2e` or `test` as a
 * word (`cashflow_e2e`, `cashflow_test`, `e2e`), not merely somewhere inside
 * another word (`latest`, `contest`).
 *
 * This is the one rule that survives an operator mistake the same-database
 * check cannot see. `isSameDatabase` only catches "the app database of THIS
 * machine"; a copy-pasted production URL on a different host passes it. A
 * marker in the name is what makes "this is a disposable database" an explicit
 * statement rather than an assumption.
 */
const TEST_DATABASE_NAME_MARKER = /(?:^|_)(?:e2e|test)(?:_|$)/i

/**
 * Whether a database NAME is one the test policy would accept as disposable.
 *
 * Exported so the rule has one reader in each direction. The Playwright guard
 * below uses it to require the marker; `lib/server/demo/guards.ts` uses it in
 * reverse, to REFUSE — the demo seed/clear scripts target the application
 * database, and a run against `cashflow_test` or `cashflow_e2e` would wipe a
 * suite's fixtures out from under it. Two copies of this regex would be two
 * copies that could drift in opposite directions.
 */
export function isTestDatabaseName(databaseName: string): boolean {
  return TEST_DATABASE_NAME_MARKER.test(databaseName)
}

export type E2eDatabaseRefusalReason = 'missing' | 'same-as-app' | 'unsafe'

export type E2eDatabaseDecision =
  | { readonly ok: true; readonly databaseUrl: string; readonly databaseName: string }
  | { readonly ok: false; readonly reason: E2eDatabaseRefusalReason; readonly message: string }

/** Shared tail: what the reader has to do about any of the refusals. */
const HOW_TO_FIX =
  `Set ${E2E_DATABASE_URL_VARIABLE} in .env to a dedicated database whose name carries ` +
  '`e2e` or `test` (e.g. …:5439/cashflow_e2e on the same server as DATABASE_URL); it is created ' +
  'and migrated automatically on the first run. See .env.example.'

/**
 * Whether the Playwright suite may run, and against what.
 *
 * Typed as a plain string map rather than `NodeJS.ProcessEnv` — Next's type
 * augmentation makes `NODE_ENV` required there — so callers can pass
 * `process.env` or a one-key literal.
 *
 * No value is ever interpolated into a message: a connection string carries a
 * password. Database NAMES are, since they are not secret and are the whole
 * subject of two of the three refusals.
 */
export function decideE2eDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): E2eDatabaseDecision {
  const databaseUrl = env[E2E_DATABASE_URL_VARIABLE]?.trim()
  if (!databaseUrl) {
    return {
      ok: false,
      reason: 'missing',
      message:
        `${E2E_DATABASE_URL_VARIABLE} is not set, so there is no database this suite is allowed ` +
        'to write to. The browser tests register real users and write real financial rows, and ' +
        `nothing cleans them up, so they must never run against DATABASE_URL. ${HOW_TO_FIX}`,
    }
  }

  // There is deliberately no default value to fall back to (unlike
  // `TEST_DATABASE_URL`): a default that happens to be wrong for one machine
  // would fail open, which is the failure mode this whole module exists to
  // remove.
  let databaseName: string
  try {
    parseConnectionString(databaseUrl, E2E_DATABASE_URL_VARIABLE)
    databaseName = assertCreatableDatabaseName(
      databaseNameOf(databaseUrl, E2E_DATABASE_URL_VARIABLE),
      E2E_DATABASE_URL_VARIABLE,
    )
  } catch (error) {
    return {
      ok: false,
      reason: 'unsafe',
      message: `${(error as Error).message} ${HOW_TO_FIX}`,
    }
  }

  const appDatabaseUrl = env.DATABASE_URL?.trim()
  if (appDatabaseUrl && isSameDatabase(appDatabaseUrl, databaseUrl)) {
    return {
      ok: false,
      reason: 'same-as-app',
      message:
        `${E2E_DATABASE_URL_VARIABLE} and DATABASE_URL address the same database ` +
        `("${databaseName}"). The browser suite writes throwaway users and financial rows and ` +
        `never removes them, so it must never run against the application database. ${HOW_TO_FIX}`,
    }
  }

  if (!isTestDatabaseName(databaseName)) {
    return {
      ok: false,
      reason: 'unsafe',
      message:
        `${E2E_DATABASE_URL_VARIABLE} names the database "${databaseName}", which is not marked ` +
        'as a test database. This suite creates it, migrates it and fills it with throwaway ' +
        `rows, so it only accepts a name carrying \`e2e\` or \`test\`. ${HOW_TO_FIX}`,
    }
  }

  return { ok: true, databaseUrl, databaseName }
}

/**
 * `decideE2eDatabaseUrl`, as an assertion: the e2e connection string, or a
 * throw carrying the refusal message.
 *
 * Used by `playwright.config.ts` (at config-load time, so a refusal happens
 * before a dev server is spawned) and again by `e2e/global-setup.ts` (which
 * needs the same value to create and migrate the database).
 */
export function assertE2eDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const decision = decideE2eDatabaseUrl(env)
  if (!decision.ok) throw new Error(decision.message)
  return decision.databaseUrl
}
