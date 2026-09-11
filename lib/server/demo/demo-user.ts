/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — NEVER FOR PRODUCTION USE.
 *
 * `seedDemoUser()` and `clearDemoUser()` — the two operations behind
 * `npm run demo:seed` and `npm run demo:clear` (spec §13).
 *
 * What they may touch is deliberately tiny: exactly one user, resolved by a
 * compiled-in email and re-verified on `isDemo` inside the deleting
 * transaction. There is no argument that names a user, no "delete everything"
 * form, and no generic user-deletion service — Phase 8 rules that out
 * explicitly, and this module does not sneak one in under a demo label.
 *
 * `User` itself is never deleted. A reset empties the demo user's owned rows
 * and leaves the account, its credential and its sessions standing, so a
 * reseed does not have to sign up again — and so `clear` can never be the
 * operation that removes a `user` row from any database.
 */

import { Prisma } from '@prisma/client'
import { auth } from '@/lib/auth/auth'
import { prisma } from '@/lib/prisma'
import { DEMO_EMAIL, DEMO_NAME, DEMO_PASSWORD, DEMO_TIMEZONE } from './constants'
import { assertDemoUserRow, assertNotProduction, DemoGuardError } from './guards'
import { deleteOwnedRows, type OwnedRowCounts } from './owned-rows'
import { seedDemoFixture, type DemoFixtureCounts, type SeedDemoFixtureOptions } from './fixture'

export interface ClearDemoUserResult {
  /** `false` when no user holds the demo email — a clean no-op, not an error. */
  found: boolean
  userId: string | null
  /** Rows removed per model, in delete order. */
  deleted: OwnedRowCounts
}

export interface SeedDemoUserResult {
  userId: string
  /** `true` when this run registered the demo account for the first time. */
  created: boolean
  /** What the reset that precedes every seed removed. */
  deleted: OwnedRowCounts
  counts: DemoFixtureCounts
}

export interface DemoOperationOptions extends SeedDemoFixtureOptions {
  /**
   * The environment guard 1 is evaluated against. Defaults to the real
   * process environment; an explicit value is how the tests exercise the
   * refusal without mutating `process.env` for every other suite.
   */
  env?: Readonly<Record<string, string | undefined>>
}

/** The three columns guard 3 needs, and nothing else. */
const IDENTITY_SELECT = { id: true, email: true, isDemo: true } as const

/**
 * Empties the demo user's ledger, in one transaction, in FK-safe order.
 *
 * The identity read happens INSIDE the transaction, immediately before the
 * first delete, and `assertDemoUserRow` runs on its result — that ordering is
 * the guard. A check against a row read a moment earlier would be a check
 * against a row that may since have been re-flagged.
 *
 * The transaction is what makes the reset all-or-nothing: a failure partway
 * down the order leaves the demo user's data exactly as it was rather than
 * half-deleted with dangling parents.
 */
export async function clearDemoUser(
  options: DemoOperationOptions = {},
): Promise<ClearDemoUserResult> {
  assertNotProduction(options.env ?? process.env)

  // A cheap pre-read so "there is no demo user" is an ordinary no-op rather
  // than a refusal. It grants nothing: the authoritative read is the one
  // inside the transaction below.
  const existing = await prisma.user.findUnique({
    where: { email: DEMO_EMAIL },
    select: { id: true },
  })
  if (!existing) return { found: false, userId: null, deleted: {} }

  const deleted = await prisma.$transaction(
    async (tx) => {
      const user = await tx.user.findUnique({
        where: { email: DEMO_EMAIL },
        select: IDENTITY_SELECT,
      })
      assertDemoUserRow(user)
      return deleteOwnedRows(tx, [user.id])
    },
    // Serializable, not the default READ COMMITTED. Under READ COMMITTED the
    // identity read above sees a snapshot taken at that statement, so a
    // concurrent `UPDATE "user" SET "isDemo" = false` could commit between the
    // guard passing and the deletes running — and the deletes would proceed
    // against a row that is no longer the demo user. Serializable makes that
    // interleaving a serialization failure instead, which surfaces as an error
    // and deletes nothing: the fail-closed answer.
    //
    // The cost is acceptable precisely because of what this transaction is:
    // a hand-run maintenance operation on one user, never concurrent with
    // itself and never on a request path, so a retry loop would be
    // ceremony — a refusal an operator re-runs is the correct behaviour here.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )

  return { found: true, userId: existing.id, deleted }
}

/**
 * Brings the demo account to a known-good state: registered, flagged, and
 * holding exactly one fixture's worth of data.
 *
 * Seed is reset-then-fill, so running it twice is the same as running it once
 * — "idempotent" here means the second run leaves the same row counts, not
 * that it does nothing. A seed that merely appended would double every figure
 * on the dashboard it exists to demonstrate.
 *
 * The user row is created through Better Auth's own server API, exactly as a
 * browser registration would, so the credential is hashed by the same code and
 * the registration hook seeds the default taxonomy. `isDemo` is then set by a
 * direct Prisma update from this trusted path only — it is `input: false` in
 * the Better Auth config and absent from every client-facing schema (§4.1),
 * and that must stay true.
 *
 * The fill itself is NOT one transaction: each service opens its own
 * (several take row locks, and `createTransaction` performs an FX lookup that
 * must not happen under one). Only the reset is transactional, which is the
 * half where partial progress would be destructive.
 */
export async function seedDemoUser(
  options: DemoOperationOptions = {},
): Promise<SeedDemoUserResult> {
  assertNotProduction(options.env ?? process.env)

  const existing = await prisma.user.findUnique({
    where: { email: DEMO_EMAIL },
    select: IDENTITY_SELECT,
  })

  if (existing && !existing.isDemo) {
    throw new DemoGuardError(
      `Refusing to seed: a user already holds ${DEMO_EMAIL} and is not flagged isDemo. ` +
        'That is a real account; nothing was created or deleted.',
    )
  }

  let userId: string
  let created = false
  if (existing) {
    userId = existing.id
  } else {
    const signUp = await auth.api.signUpEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
    })
    userId = signUp.user.id
    created = true
    // The one direct write to `isDemo` in the whole codebase (spec §4.1). The
    // timezone is pinned alongside it so the user's own period math and the
    // fixture's calendar are provably the same zone, rather than agreeing only
    // because the column default happens to match today.
    await prisma.user.update({
      where: { id: userId },
      data: { isDemo: true, timezone: DEMO_TIMEZONE },
    })
  }

  // Reset first, through the same guarded path `demo:clear` uses — including
  // its in-transaction `isDemo` re-check, which now covers the row this
  // function just created or adopted.
  const { deleted } = await clearDemoUser(options)
  const counts = await seedDemoFixture(userId, options)

  return { userId, created, deleted, counts }
}
