/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — DO NOT USE IN PRODUCTION.
 *
 * `npm run demo:seed` — fills the dedicated demo account with a realistic
 * three-month ledger so the dashboard, reports and export can be evaluated
 * immediately (spec §13).
 *
 * A thin wrapper on purpose: load the environment the way the app loads it,
 * run the two environment guards, call the one operation, print the counts.
 * Every decision worth testing lives in `lib/server/demo/`, which is where the
 * tests exercise it — a script body is the one place a unit test cannot reach.
 *
 * Every import of ours is dynamic and happens INSIDE `main`, after
 * `loadEnvConfig` has run. Static imports are hoisted and evaluated before the
 * module body, and `lib/prisma.ts` reads `DATABASE_URL` at module load — so a
 * static import here would build the Prisma client against an environment the
 * `.env` files had not been read into yet.
 */

import { loadEnvConfig } from '@next/env'

// `.env*` in the same precedence order `next dev` uses
// (`.env.development.local` → `.env.local` → `.env.development` → `.env`),
// for the reason `playwright.config.ts` spells out: a plain `dotenv/config`
// reads only the last of them, so a `DATABASE_URL` living in `.env.local`
// would be invisible here and visible to the server — and the database guard
// below would then be checking the wrong value. Like dotenv it never
// overrides an already-set variable, so an exported shell value still wins.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')

/**
 * The Prisma client, once the guards have let us reach it. Held here so the
 * `finally` below closes a connection that was actually opened, and never
 * constructs one on the refusal path — building it would run the server
 * environment contract and print its warnings underneath the refusal message,
 * which is the last thing an operator reading a refusal needs.
 */
let prismaModule: typeof import('@/lib/prisma') | undefined

async function main(): Promise<void> {
  // The guards come from their own module, ahead of everything else: that file
  // imports only pure connection-string helpers, whereas the demo module
  // reaches `lib/auth/auth.ts` -> `loadServerEnv()` at module scope, which in a
  // production process THROWS before any code of ours could run. Loading the
  // guards first is what turns "production, no override" into the one-line
  // refusal below instead of an environment-validation stack trace.
  const { assertApplicationDatabase, assertNotProduction } =
    await import('@/lib/server/demo/guards')

  // Guard 1, then guard 2. Guard 3 (the `isDemo` re-check) runs inside the
  // reset, in the same transaction as the deletes.
  assertNotProduction()
  const databaseName = assertApplicationDatabase()

  // The same contract the app boots against, so a broken environment fails
  // here for the same reasons and with the same names-only message.
  const { loadServerEnv } = await import('@/lib/server/env')
  loadServerEnv()

  const { DEMO_EMAIL, DEMO_PASSWORD, seedDemoUser } = await import('@/lib/server/demo')
  prismaModule = await import('@/lib/prisma')

  console.log(`Seeding the demo account into database "${databaseName}".`)

  const result = await seedDemoUser()

  if (result.created) {
    // The reset still ran, but the only rows it could find are the default
    // account types and categories the registration hook had just created —
    // reporting that as "existing demo data" would be misleading.
    console.log('Demo user registered.')
  } else {
    const removed = Object.values(result.deleted).reduce((total, n) => total + n, 0)
    console.log(`Demo user already existed; removed ${removed} row(s) before reseeding.`)
  }
  console.log('Seeded:')
  for (const [entity, count] of Object.entries(result.counts)) {
    console.log(`  ${entity}: ${count}`)
  }
  console.log(`\nSign in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
}

main()
  .catch(async (error: unknown) => {
    // A guard refusal is a decision, not a crash: print the reason (which
    // names variables and database names only, never a value) and exit
    // non-zero without a stack trace.
    const { DemoGuardError } = await import('@/lib/server/demo/guards')
    console.error(error instanceof DemoGuardError ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await prismaModule?.prisma.$disconnect()
    } catch {
      // A failure while closing the pool must not replace the real outcome
      // (or the real refusal) with a misleading second error.
    }
  })
