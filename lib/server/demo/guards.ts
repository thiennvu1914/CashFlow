/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — NEVER FOR PRODUCTION USE.
 *
 * The three fail-closed decisions that stand between `npm run demo:seed` /
 * `npm run demo:clear` and a database they must not write to. They run in this
 * order, and every one of them refuses by default:
 *
 * 1. `assertNotProduction` — a production process is refused outright unless
 *    `ALLOW_DEMO_SEED_IN_PRODUCTION=true` is set deliberately. This is the
 *    variable `.env.example` has documented since Phase 0; it is real from
 *    here on.
 * 2. `assertApplicationDatabase` — the resolved `DATABASE_URL` must NOT be a
 *    database the test policy would accept as disposable (`cashflow_test`,
 *    `cashflow_e2e`, anything carrying `test`/`e2e` as a word), and must not
 *    be the same database as `TEST_DATABASE_URL` or `E2E_DATABASE_URL`. The
 *    demo scripts target the application database — that is their whole
 *    purpose — and a run against a suite's database would delete its fixtures
 *    mid-run.
 * 3. `assertDemoUserRow` — the row about to be emptied is re-read from the
 *    database immediately before the delete and must carry BOTH the fixed demo
 *    email and `isDemo === true`. Neither check is redundant: the flag alone
 *    would let a mis-flagged real user be wiped, the email alone would let a
 *    real person who registered `demo@cashflow.local` be wiped.
 *
 * Where each guard runs, and why it is split that way:
 *
 * - 1 and 2 are *environment* preconditions and are enforced by the two script
 *   entry points (`scripts/seed-demo.ts`, `scripts/clear-demo.ts`), which are
 *   the only production-reachable callers. Guard 1 is ALSO re-asserted inside
 *   `seedDemoUser`/`clearDemoUser` themselves, so no future caller can reach
 *   the writes in a production process without the override.
 * - Guard 2 is deliberately NOT inside those functions: the Vitest suite
 *   exercises the real seed and reset against `cashflow_test`, which is
 *   exactly the database this guard forbids a *script* from touching. Moving
 *   it inside would force a test-only bypass, and a bypass that exists is a
 *   bypass that can open in production (the reasoning in
 *   `lib/auth/create-auth.ts` about `CASHFLOW_E2E_DISABLE_RATE_LIMIT`).
 * - 3 is about the target row rather than the environment, so it lives inside
 *   the reset itself, where it cannot be skipped by any caller.
 *
 * No message here ever interpolates a connection string — that value carries a
 * password. Database NAMES are printed, exactly as `lib/server/env.ts` and
 * `lib/testing/e2e-database-url.ts` do: they are not secret and they are the
 * subject of the refusal.
 */

import { databaseNameOf, isSameDatabase, parseConnectionString } from '@/lib/testing/database-url'
import { isTestDatabaseName } from '@/lib/testing/e2e-database-url'
import { DEMO_EMAIL } from './constants'

/** The deliberately unambiguous production override (spec §13). */
export const DEMO_PRODUCTION_OVERRIDE = 'ALLOW_DEMO_SEED_IN_PRODUCTION'

/**
 * A refusal by one of the guards above.
 *
 * Its own class so the scripts can print the message and exit non-zero without
 * a stack trace, while a genuine fault still surfaces as one.
 */
export class DemoGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoGuardError'
  }
}

/** `undefined` for an unset or blank value, so `""` never counts as set. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Guard 1. Refuses a production process unless the override says otherwise.
 *
 * Fail-closed on the override too: only the exact string `'true'` opens it, so
 * a `1`, a `yes` or a stray whitespace-only value is a refusal rather than a
 * surprise. The check is on `NODE_ENV === 'production'` specifically — an
 * unset `NODE_ENV` is how `tsx scripts/…` runs by hand on a developer machine,
 * and blocking that would block the only intended use.
 */
export function assertNotProduction(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.NODE_ENV !== 'production') return
  if (trimmedOrUndefined(env[DEMO_PRODUCTION_OVERRIDE]) === 'true') return
  throw new DemoGuardError(
    'Refusing to run: NODE_ENV is production. The demo scripts create and delete real ' +
      `financial rows for ${DEMO_EMAIL}. Set ${DEMO_PRODUCTION_OVERRIDE}=true to override ` +
      '(not recommended; the demo password is public in this repository, so change it or ' +
      'remove the account right after seeding).',
  )
}

/**
 * Guard 2. Resolves the application database and refuses every test database.
 *
 * Returns the database NAME, which the scripts print so an operator can see
 * what they are about to change before they see the summary counts.
 */
export function assertApplicationDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const databaseUrl = trimmedOrUndefined(env.DATABASE_URL)
  if (databaseUrl === undefined) {
    throw new DemoGuardError(
      'Refusing to run: DATABASE_URL is not set, so there is no database to act on. ' +
        'Copy .env.example to .env (see README).',
    )
  }

  let databaseName: string
  try {
    parseConnectionString(databaseUrl, 'DATABASE_URL')
    databaseName = databaseNameOf(databaseUrl, 'DATABASE_URL')
  } catch (error) {
    throw new DemoGuardError(`Refusing to run: ${(error as Error).message}`)
  }

  if (isTestDatabaseName(databaseName)) {
    throw new DemoGuardError(
      `Refusing to run: DATABASE_URL names the database "${databaseName}", which the test ` +
        'policy treats as a disposable test database. The demo scripts act on the ' +
        "application database only — running them here would delete a suite's fixtures " +
        'while it is using them.',
    )
  }

  for (const variable of ['TEST_DATABASE_URL', 'E2E_DATABASE_URL'] as const) {
    const other = trimmedOrUndefined(env[variable])
    if (other !== undefined && isSameDatabase(databaseUrl, other)) {
      throw new DemoGuardError(
        `Refusing to run: DATABASE_URL and ${variable} address the same database ` +
          `("${databaseName}"). The demo scripts act on the application database only.`,
      )
    }
  }

  return databaseName
}

/** The three columns guard 3 needs; anything wider would be read for nothing. */
export interface DemoUserIdentity {
  id: string
  email: string
  isDemo: boolean
}

/**
 * Guard 3. The last thing that happens before a delete: the row as the
 * database has it right now must be the demo user, on both facts.
 *
 * Written as a plain assertion over an already-read row rather than as its own
 * query, so the caller controls WHEN the read happens — which is the whole
 * point. It has to be the read taken inside the deleting transaction, not one
 * from a moment earlier.
 */
export function assertDemoUserRow(user: DemoUserIdentity | null): asserts user is DemoUserIdentity {
  if (user === null) {
    throw new DemoGuardError(
      `Refusing to delete: no user with the demo email (${DEMO_EMAIL}) exists in this database.`,
    )
  }
  if (user.email !== DEMO_EMAIL) {
    throw new DemoGuardError(
      'Refusing to delete: the resolved user does not carry the demo email. Nothing was deleted.',
    )
  }
  if (!user.isDemo) {
    throw new DemoGuardError(
      `Refusing to delete: the user holding ${DEMO_EMAIL} is not flagged isDemo. That is a real ` +
        'account, not the demo account, and nothing was deleted.',
    )
  }
}
