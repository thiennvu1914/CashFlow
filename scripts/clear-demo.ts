/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — DO NOT USE IN PRODUCTION.
 *
 * `npm run demo:clear` — empties the dedicated demo account's ledger (spec
 * §13). It deletes rows whose `userId` is the demo user's and nothing else:
 * no other user is read, let alone written, and the demo `user` row itself is
 * kept so `demo:seed` can refill it without registering again.
 *
 * The same thin-wrapper shape as `seed-demo.ts`, and the same reason every
 * import of ours is dynamic — see that file's header.
 */

import { loadEnvConfig } from '@next/env'

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
  // Guards first, from their own pure module — see `seed-demo.ts` for why the
  // order of these imports is itself a guarantee.
  const { assertApplicationDatabase, assertNotProduction } =
    await import('@/lib/server/demo/guards')

  // Guard 1, then guard 2. Guard 3 (the `isDemo` re-check) runs inside
  // `clearDemoUser`, in the same transaction as the deletes.
  assertNotProduction()
  const databaseName = assertApplicationDatabase()

  const { loadServerEnv } = await import('@/lib/server/env')
  loadServerEnv()

  const { clearDemoUser, DEMO_EMAIL } = await import('@/lib/server/demo')
  prismaModule = await import('@/lib/prisma')

  console.log(`Clearing the demo account in database "${databaseName}".`)

  const result = await clearDemoUser()

  if (!result.found) {
    console.log(`No user holds ${DEMO_EMAIL} in this database — nothing to clear.`)
    return
  }

  const total = Object.values(result.deleted).reduce((sum, n) => sum + n, 0)
  console.log(`Deleted ${total} row(s):`)
  for (const [model, count] of Object.entries(result.deleted)) {
    console.log(`  ${model}: ${count}`)
  }
  console.log('The demo user row, its credential and its sessions were kept.')
}

main()
  .catch(async (error: unknown) => {
    const { DemoGuardError } = await import('@/lib/server/demo/guards')
    console.error(error instanceof DemoGuardError ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await prismaModule?.prisma.$disconnect()
    } catch {
      // See `seed-demo.ts`: a close failure must not mask the real outcome.
    }
  })
