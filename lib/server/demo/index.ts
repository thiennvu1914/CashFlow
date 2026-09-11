/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — NEVER FOR PRODUCTION USE.
 *
 * The public face of the demo module: what `scripts/seed-demo.ts` and
 * `scripts/clear-demo.ts` import. Nothing in `app/`, `components/` or
 * `lib/server/actions/` imports anything from this directory — the demo
 * operations are reachable from the two scripts and their tests only.
 */

export { DEMO_EMAIL, DEMO_NAME, DEMO_PASSWORD, DEMO_TIMEZONE } from './constants'
export {
  assertApplicationDatabase,
  assertDemoUserRow,
  assertNotProduction,
  DEMO_PRODUCTION_OVERRIDE,
  DemoGuardError,
} from './guards'
export { clearDemoUser, seedDemoUser } from './demo-user'
export type { ClearDemoUserResult, DemoOperationOptions, SeedDemoUserResult } from './demo-user'
export type { DemoFixtureCounts } from './fixture'
export { deleteOwnedRows, OWNED_ROW_DELETIONS } from './owned-rows'
export type { OwnedRowCounts } from './owned-rows'
