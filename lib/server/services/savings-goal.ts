import { Prisma } from '@prisma/client'
import type { SavingsGoalStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { calendarDateToUtcCarrier } from '@/lib/datetime/calendar-date'
import {
  createSavingsGoalSchema,
  updateSavingsGoalProgressSchema,
  updateSavingsGoalSchema,
  type CreateSavingsGoalInput,
  type UpdateSavingsGoalInput,
  type UpdateSavingsGoalProgressInput,
} from '@/lib/validation/savings-goal'

/**
 * Savings-goal service (spec §4.8).
 *
 * Four invariants live here and are never delegated to the UI:
 *
 * 1. **Tracking only, and manual.** Nothing in this file creates a Transaction
 *    or a Transfer, reads or writes a FinancialAccount, or changes a balance —
 *    it imports none of `transaction.ts`, `transfer.ts` or `balance.ts`, and
 *    `savings-goal.test.ts` proves the absence by seeding an account plus a
 *    transaction, running every mutation below, and re-checking both counts and
 *    the balance. `currentProgress` is a figure the user types in ("I moved
 *    2,000,000 into the goal jar"), never something inferred from an account:
 *    an account balance is money the user *has*, a goal's progress is money
 *    they have *earmarked*, and no automatic rule can tell one from the other.
 *    A goal reaching its target therefore moves nothing.
 * 2. **ACHIEVED is derived, never stored as a decision.** Spec §5's "never store
 *    what can drift" applies to a status as much as to a balance. `ACHIEVED`
 *    is recomputed from `currentProgress >= targetAmount` on *every* write, so
 *    raising a target past what is already saved reverts the goal to ACTIVE by
 *    itself and no reconciliation job is ever needed. If it were a state the
 *    user set, an edited target would leave a goal claiming to be achieved on
 *    an amount it no longer meets.
 * 3. **ARCHIVED is the one stored human decision**, and it is terminal.
 *    "I gave up on this" / "I already bought it" is not derivable from any
 *    figure, so it is stored — and once stored, edits and progress updates are
 *    refused (`SavingsGoalArchivedError`) rather than silently un-archiving.
 *    The row stays readable forever; nothing here deletes a goal.
 * 4. **Each goal keeps its own currency.** `User.baseCurrency` is display-only
 *    (ledger ruling R5-3) and no code path here converts a target or a
 *    progress figure — a 50,000,000 VND goal and a 2,000 USD goal are two
 *    separate targets, never summed. Consequently there is no FX import at all,
 *    and money is `Prisma.Decimal` end to end; the only `toNumber()` for a goal
 *    is the progress bar's width in `lib/ui/savings-goal-view-model.ts`.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — there is no ambient user here.
 * Every single-row lookup goes through the composite `userId_id` key, so
 * another user's goal id is a P2025, never a usable reference.
 */

/**
 * Thrown when an archived goal would be edited, progressed, or otherwise
 * changed.
 *
 * A distinct error rather than a P2025: the row exists and the user can still
 * see it under "Archived goals", so "that goal no longer exists" would be a
 * lie. The action layer maps this to its own code and the UI says the goal is
 * archived.
 */
export class SavingsGoalArchivedError extends Error {
  constructor() {
    super('This goal is archived and can no longer be changed.')
    this.name = 'SavingsGoalArchivedError'
  }
}

/**
 * A whole `SavingsGoal` row. Written as a `GetPayload` with no arguments
 * rather than as the bare model type so it stays the *service's* return type:
 * if a later phase adds an `include` (there is no relation to include today),
 * every caller widens with it instead of silently not seeing the new field.
 */
export type SavingsGoalRow = Prisma.SavingsGoalGetPayload<Record<string, never>>

/**
 * The status a goal must have, given its progress and target.
 *
 * `stored` is consulted for exactly one reason: ARCHIVED wins over everything.
 * An archived goal that happens to have progress past its target is still
 * archived — the user's decision outranks the arithmetic — and every mutation
 * below refuses to touch such a row anyway.
 *
 * Compared with `Decimal.gte`, never through `toNumber()`: at VND magnitudes a
 * float detour can flip the exact-boundary case, and "saved precisely the
 * target" is the case that most needs to read ACHIEVED. Exported (and tested
 * directly) because it is the whole of invariant 2 in three lines.
 */
export function deriveSavingsGoalStatus(
  current: Prisma.Decimal,
  target: Prisma.Decimal,
  stored: SavingsGoalStatus,
): SavingsGoalStatus {
  if (stored === 'ARCHIVED') return 'ARCHIVED'
  return current.gte(target) ? 'ACHIEVED' : 'ACTIVE'
}

/** Goals in progress before goals already met — the order the Savings page and
 *  the dashboard widget both render. */
const STATUS_RANK: Record<SavingsGoalStatus, number> = { ACTIVE: 0, ACHIEVED: 1, ARCHIVED: 2 }

/**
 * Sorted in memory rather than with `orderBy: { status: 'asc' }`, which would
 * order by the enum's *declaration* order in Postgres and so make the page's
 * display order an invisible consequence of how `SavingsGoalStatus` happens to
 * be written in `schema.prisma`. The rank above says the intent outright.
 *
 * All three keys are compared here rather than relying on `Array#sort` being
 * stable over a database `orderBy`: the tie-breaks make the order total, so two
 * goals created in the same millisecond cannot render in one order on one
 * request and the other order on the next.
 */
function compareForDisplay(a: SavingsGoalRow, b: SavingsGoalRow): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  )
}

/**
 * The goals the Savings page and the dashboard widget show: everything the user
 * is still tracking, in progress first.
 *
 * ARCHIVED rows are excluded here and only here — they are still readable via
 * `listAllSavingsGoals`, which is what feeds the page's "Archived goals"
 * section. Archiving hides a goal from the working list; it never erases it.
 */
export async function listSavingsGoals(userId: string): Promise<SavingsGoalRow[]> {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId, status: { not: 'ARCHIVED' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return goals.sort(compareForDisplay)
}

/**
 * Every goal the user has ever set, archived ones included — the page's
 * archived section and (from Group 7) the export sheet's data source.
 *
 * Oldest first and *not* status-ranked: this is a history, and a history reads
 * in the order things happened. Unbounded by design, like `listAllBudgets`: a
 * cap on a user's complete data is silent data loss rather than a safeguard.
 */
export async function listAllSavingsGoals(userId: string): Promise<SavingsGoalRow[]> {
  return prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** `undefined` (no deadline) stays `null`; a `yyyy-MM-dd` becomes its
 *  UTC-midnight carrier. The only place a goal's deadline is built. */
function deadlineCarrier(deadline: string | undefined): Date | null {
  return deadline === undefined ? null : calendarDateToUtcCarrier(deadline)
}

/**
 * Creates a goal.
 *
 * Fields are listed explicitly rather than spread, so the authenticated
 * `userId` can never be overridden regardless of Zod's stripping behaviour and
 * a client-supplied `status` is ignored rather than obeyed — `status` is
 * derived here from the very progress being written, so a goal created with
 * enough already saved is ACHIEVED from its first render.
 *
 * `currentProgress` defaults to 0 in this layer, not in Zod: "how much have you
 * already put aside?" is a question the user may skip, and the default belongs
 * next to the write that needs it.
 */
export async function createSavingsGoal(
  userId: string,
  input: CreateSavingsGoalInput,
): Promise<SavingsGoalRow> {
  const parsed = createSavingsGoalSchema.parse(input)
  const targetAmount = new Prisma.Decimal(parsed.targetAmount)
  const currentProgress = new Prisma.Decimal(parsed.currentProgress ?? 0)

  return prisma.savingsGoal.create({
    data: {
      userId,
      name: parsed.name,
      targetAmount,
      currentProgress,
      currency: parsed.currency,
      deadline: deadlineCarrier(parsed.deadline),
      note: parsed.note ?? null,
      // 'ACTIVE' as the stored value because there is no stored row yet; a new
      // goal cannot be archived.
      status: deriveSavingsGoalStatus(currentProgress, targetAmount, 'ACTIVE'),
    },
  })
}

/**
 * Changes a goal's definition — name, target, currency, deadline, note — but
 * never its progress, which has its own action. The two are separate user
 * intents ("I actually need 60 million" vs "I saved another 2 million") and
 * folding them into one write would make either an accidental overwrite of the
 * other.
 *
 * The row is read first, through the composite `userId_id` key, for two
 * reasons: another user's goal id resolves to nothing and raises Prisma's P2025
 * (which propagates untouched, exactly as the transaction services do), and the
 * *existing* progress is what the new status is derived against. Raising a
 * target above what is already saved therefore flips an ACHIEVED goal back to
 * ACTIVE, and lowering it below flips it forward — from this one write, with no
 * separate recompute step.
 */
export async function updateSavingsGoal(
  userId: string,
  goalId: string,
  input: UpdateSavingsGoalInput,
): Promise<SavingsGoalRow> {
  const parsed = updateSavingsGoalSchema.parse(input)
  const existing = await prisma.savingsGoal.findUniqueOrThrow({
    where: { userId_id: { userId, id: goalId } },
  })
  if (existing.status === 'ARCHIVED') throw new SavingsGoalArchivedError()

  const targetAmount = new Prisma.Decimal(parsed.targetAmount)
  return prisma.savingsGoal.update({
    where: { userId_id: { userId, id: goalId } },
    data: {
      name: parsed.name,
      targetAmount,
      currency: parsed.currency,
      // An edit that clears the deadline field stores `null` — the absence has
      // to be written, not skipped, or the old deadline would survive.
      deadline: deadlineCarrier(parsed.deadline),
      note: parsed.note ?? null,
      status: deriveSavingsGoalStatus(existing.currentProgress, targetAmount, existing.status),
    },
  })
}

/**
 * Records how much the user has now put aside.
 *
 * The new figure is stored as given, even above the target: over-saving is
 * real, and clamping it here would destroy a number the user typed. Only the
 * progress *bar* is clamped, in the view model.
 *
 * The status is re-derived against the goal's existing target, so the write
 * that reaches the target is the write that marks it ACHIEVED — there is no
 * moment at which the two disagree.
 */
export async function updateSavingsGoalProgress(
  userId: string,
  goalId: string,
  input: UpdateSavingsGoalProgressInput,
): Promise<SavingsGoalRow> {
  const parsed = updateSavingsGoalProgressSchema.parse(input)
  const existing = await prisma.savingsGoal.findUniqueOrThrow({
    where: { userId_id: { userId, id: goalId } },
  })
  if (existing.status === 'ARCHIVED') throw new SavingsGoalArchivedError()

  const currentProgress = new Prisma.Decimal(parsed.currentProgress)
  return prisma.savingsGoal.update({
    where: { userId_id: { userId, id: goalId } },
    data: {
      currentProgress,
      status: deriveSavingsGoalStatus(currentProgress, existing.targetAmount, existing.status),
    },
  })
}

/**
 * Retires a goal. The row is kept — nothing here deletes a goal — and the page
 * shows it under "Archived goals" from then on.
 *
 * Idempotent, and deliberately not a `SavingsGoalArchivedError`: archiving an
 * already-archived goal is the *same request as the one that succeeded*, which
 * is what a double-click or a stale tab produces, and answering it with an
 * error would report a failure for a state the user already has. Editing or
 * progressing an archived goal still throws, because those ask for a change
 * that will not happen. The early return makes it a true no-op — no write at
 * all, so `updatedAt` is not bumped either.
 */
export async function archiveSavingsGoal(userId: string, goalId: string): Promise<SavingsGoalRow> {
  const existing = await prisma.savingsGoal.findUniqueOrThrow({
    where: { userId_id: { userId, id: goalId } },
  })
  if (existing.status === 'ARCHIVED') return existing

  return prisma.savingsGoal.update({
    where: { userId_id: { userId, id: goalId } },
    data: { status: 'ARCHIVED' },
  })
}
