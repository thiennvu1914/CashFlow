/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — NEVER FOR PRODUCTION USE.
 *
 * The fixed identity of the one account `npm run demo:seed` and
 * `npm run demo:clear` are allowed to touch (spec §13).
 *
 * Nothing here is ever taken from `argv` or from the environment: an operator
 * who could name the target user could name a real one, and the whole point of
 * these scripts is that they have exactly one possible subject.
 */

/**
 * The demo user's email. `.local` is reserved by RFC 6762 and can never be a
 * real deliverable address, so this account cannot collide with a person's.
 *
 * Identity is checked on BOTH this email and `User.isDemo` before any delete
 * (see `assertDemoUserRow`): the flag alone would let a mis-flagged real user
 * be wiped, and the email alone would let a real user who registered this
 * address be wiped.
 */
export const DEMO_EMAIL = 'demo@cashflow.local'

/** Shown in the app's header; not an identity check. */
export const DEMO_NAME = 'Demo User'

/**
 * The demo account's password, deliberately public in this repository.
 *
 * It is safe precisely because the scripts that set it refuse to run against a
 * production database at all (`assertNotProduction`), so it can never be the
 * password of a reachable account. It is printed by `demo:seed` on purpose —
 * an operator needs it to sign in — and is the one value these scripts print.
 */
export const DEMO_PASSWORD = 'demo-password-not-for-production'

/**
 * The zone every demo date is built in. UTC+7, no DST, so the fixture's
 * wall-clock arithmetic is exact and a run on any developer's machine produces
 * the same calendar days. It is also the `User.timezone` default
 * (`lib/auth/user-defaults.ts`), so the seeded rows and the demo user's own
 * period math agree.
 */
export const DEMO_TIMEZONE = 'Asia/Ho_Chi_Minh'
