import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { formatCalendarDate } from '@/lib/datetime/calendar-date'
import { readMigrationSql, splitSqlStatements } from '@/lib/testing/migration-sql'
import { ArchivedAccountError } from './account-lock'
import { AccountFollowedByGoalError, updateFinancialAccount } from './financial-account'
import { getAccountBalance } from './balance'
import { createTransfer } from './transfer'
import {
  addSavingsGoalEntry,
  archiveSavingsGoal,
  createSavingsGoal,
  deleteSavingsGoalEntry,
  deriveSavingsGoalStatus,
  listAllSavingsGoals,
  listSavingsGoals,
  updateSavingsGoal,
  updateSavingsGoalEntry,
  SavingsGoalArchivedError,
  SavingsGoalCurrencyLockedError,
  SavingsGoalLinkedError,
  SavingsGoalWithdrawalExceedsProgressError,
  type SavingsGoalRow,
} from './savings-goal'

/**
 * The savings-goal data layer (spec §4.8, amended by money-source linking,
 * spec 2026-10-12 §2 Q5, §5 and §6.7).
 *
 * The properties this suite exists to hold:
 *
 * 1. **Progress is derived, never stored.** A goal linked to an account reads
 *    that account's current derived balance — so a transfer into the account
 *    moves the goal with no goal write at all — and an unlinked goal reads
 *    Σ contributions − Σ withdrawals over its entries. The deprecated
 *    `currentProgress` column is neither read nor written.
 * 2. **Progress never goes below zero.** A withdrawal, a shrunk contribution
 *    or a deleted one that would take an unlinked goal negative is refused,
 *    under the goal's row lock, so two concurrent withdrawals cannot both pass.
 * 3. **Entries belong to unlinked, unarchived goals only.**
 * 4. **ACHIEVED is derived from that progress**, on every read and every write,
 *    at the exact `Decimal` boundary.
 * 5. **ARCHIVED is terminal but archiving is idempotent.**
 * 6. **Every query is tenant-scoped**: another user's goal, entry or account is
 *    a P2025 and their rows stay byte-identical.
 * 7. **Nothing here moves money** — a goal follows an account, it never writes
 *    to one.
 * 8. **The data backfill is idempotent**: the migration's INSERT, run twice,
 *    gives each pre-existing goal exactly one opening contribution.
 *
 * `fetch` is a throwing spy for every test and `afterEach` asserts it was never
 * called: a savings goal has no FX dimension at all (each goal keeps its own
 * currency), so any network access here would be a bug rather than a slow test.
 */

/** UTC+7, no DST — so no wall-clock assertion below depends on a DST date. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'
const CONTEXT = { timezone: TEST_TIMEZONE }

interface GoalFixture {
  userId: string
  accountTypeId: string
  /** "Wallet", VND: 5,000,000 initial − a 250,000 expense = 4,750,000. */
  accountId: string
  transactionId: string
}

/**
 * A user with one account and one expense already recorded — the expense so
 * the account's derived balance is a real, non-initial figure, and so the
 * "no money moves" case has something that *could* be corrupted.
 */
async function createGoalUser(): Promise<GoalFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `goal-${randomUUID()}@example.com`,
      name: 'Goal Test',
      emailVerified: false,
      timezone: TEST_TIMEZONE,
    },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const account = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Wallet',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('5000000'),
      currency: 'VND',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  })
  const date = new Date('2026-03-15T05:00:00.000Z')
  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      accountId: account.id,
      type: 'EXPENSE',
      amount: new Prisma.Decimal('250000'),
      currency: 'VND',
      date,
      vndPerUsdAtEntry: new Prisma.Decimal(25000),
      fxRateFetchedAt: date,
      fxRateEffectiveAt: new Date('2026-03-15T00:00:00.000Z'),
      fxRateSource: 'savings-goal-test',
    },
  })
  return {
    userId: user.id,
    accountTypeId: accountType.id,
    accountId: account.id,
    transactionId: transaction.id,
  }
}

/** A second account of the fixture user, created long before any test's `now`. */
async function createAccount(
  fx: GoalFixture,
  data: { name: string; currency?: 'VND' | 'USD'; initialBalance?: string; archived?: boolean },
) {
  return prisma.financialAccount.create({
    data: {
      userId: fx.userId,
      accountTypeId: fx.accountTypeId,
      name: data.name,
      currency: data.currency ?? 'VND',
      initialBalance: new Prisma.Decimal(data.initialBalance ?? '0'),
      status: data.archived ? 'ARCHIVED' : 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  })
}

/** Deletes a user's rows in FK order, then the user. */
async function cleanupUsers(userIds: string[]) {
  if (userIds.length === 0) return
  try {
    await prisma.savingsGoalEntry.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.savingsGoal.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

function isKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError
}

/** Runs `promise` and returns whatever it threw, or `undefined` if it resolved. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

async function expectPrismaCode(promise: Promise<unknown>, code: string) {
  const caught = await captureRejection(promise)
  expect(isKnownRequestError(caught)).toBe(true)
  expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe(code)
}

/** The minimum a create needs — every case overrides what it cares about. */
const BASE_INPUT = {
  name: 'MacBook Pro',
  targetAmount: 50_000_000,
  currency: 'VND' as const,
}

/** One listed goal, by id — what the page and the dashboard actually render. */
async function listed(userId: string, goalId: string, now?: Date): Promise<SavingsGoalRow> {
  const goal = (await listAllSavingsGoals(userId, { now })).find((row) => row.id === goalId)
  if (!goal) throw new Error(`goal ${goalId} not listed`)
  return goal
}

async function storedGoal(userId: string, goalId: string) {
  return prisma.savingsGoal.findUniqueOrThrow({ where: { userId_id: { userId, id: goalId } } })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `write` on a row this test holds locked, inside a transaction that
 * commits only after `contender` has had time to reach the same lock — a
 * deterministic interleaving: the contender either queues behind the lock
 * (and then sees the committed write) or, if it takes no lock, works from the
 * stale pre-write state.
 */
async function raceAgainstHeldWrite<T>(
  write: (tx: Prisma.TransactionClient) => Promise<unknown>,
  contender: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  let written!: () => void
  const writeDone = new Promise<void>((resolve) => (written = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const holder = prisma.$transaction(async (tx) => {
    await write(tx)
    written()
    await released
  })
  await writeDone
  const outcome = Promise.allSettled([contender()]).then(([result]) => result)
  await pause(300)
  release()
  await holder
  return outcome
}

describe('deriveSavingsGoalStatus', () => {
  const d = (value: string) => new Prisma.Decimal(value)

  it('is ACHIEVED at or above the target and ACTIVE below it', () => {
    expect(deriveSavingsGoalStatus(d('0'), d('100'), 'ACTIVE')).toBe('ACTIVE')
    expect(deriveSavingsGoalStatus(d('99.99'), d('100'), 'ACTIVE')).toBe('ACTIVE')
    expect(deriveSavingsGoalStatus(d('100'), d('100'), 'ACTIVE')).toBe('ACHIEVED')
    expect(deriveSavingsGoalStatus(d('100.01'), d('100'), 'ACTIVE')).toBe('ACHIEVED')
  })

  it('treats a stored scale as the same number', () => {
    // What Postgres hands back for a `Decimal(18, 2)` column: "100.00", not
    // "100". A string comparison would call this ACTIVE.
    expect(deriveSavingsGoalStatus(d('100.00'), d('100'), 'ACTIVE')).toBe('ACHIEVED')
    expect(deriveSavingsGoalStatus(d('100'), d('100.00'), 'ACTIVE')).toBe('ACHIEVED')
  })

  it('re-derives an already-ACHIEVED goal back to ACTIVE', () => {
    expect(deriveSavingsGoalStatus(d('100'), d('200'), 'ACHIEVED')).toBe('ACTIVE')
  })

  it('reads a negative progress (an overdrawn linked account) as ACTIVE', () => {
    expect(deriveSavingsGoalStatus(d('-500'), d('100'), 'ACTIVE')).toBe('ACTIVE')
  })

  it('keeps ARCHIVED whatever the arithmetic says', () => {
    expect(deriveSavingsGoalStatus(d('0'), d('100'), 'ARCHIVED')).toBe('ARCHIVED')
    expect(deriveSavingsGoalStatus(d('500'), d('100'), 'ARCHIVED')).toBe('ARCHIVED')
  })

  it('does not lose the boundary to a float detour', () => {
    // 100.10 as a double is 100.09999999999999432..., so `toNumber() >=`
    // arithmetic on these two values is exactly where a naive implementation
    // reports the wrong status.
    expect(deriveSavingsGoalStatus(d('100.10'), d('100.10'), 'ACTIVE')).toBe('ACHIEVED')
    expect(deriveSavingsGoalStatus(d('100.09'), d('100.10'), 'ACTIVE')).toBe('ACTIVE')
  })
})

describe('savings-goal service', () => {
  let fetchSpy: MockInstance
  let fx: GoalFixture
  /** Extra users a single case created; cleaned up with the fixture. */
  let extraUserIds: string[]

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    extraUserIds = []
    fx = await createGoalUser()
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    await cleanupUsers([fx.userId, ...extraUserIds])
    // A goal keeps its own currency and is never converted, so no code path
    // here has any reason to reach an FX provider.
    expect(fetchCalls).toBe(0)
  })

  describe('create', () => {
    it('starts unlinked at zero progress, ACTIVE, with no entries and no deadline', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      expect(goal.name).toBe('MacBook Pro')
      expect(goal.targetAmount.toString()).toBe('50000000')
      expect(goal.progress.toString()).toBe('0')
      expect(goal.linkedAccount).toBeNull()
      expect(goal.linkedAccountId).toBeNull()
      expect(goal.currency).toBe('VND')
      expect(goal.status).toBe('ACTIVE')
      expect(goal.deadline).toBeNull()
      expect(goal.note).toBeNull()
      expect(goal.userId).toBe(fx.userId)
      // The deprecated column is not even part of what the service returns.
      expect(goal).not.toHaveProperty('currentProgress')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('records the initial amount as a first CONTRIBUTION dated today in the user zone', async () => {
      // 20:00 UTC on the 15th is already 03:00 on the 16th in Ho Chi Minh City.
      const now = new Date('2026-03-15T20:00:00.000Z')
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000_000, initialContribution: 400_000 },
        CONTEXT,
        now,
      )

      expect(goal.progress.toString()).toBe('400000')
      expect(goal.status).toBe('ACTIVE')
      const entries = await prisma.savingsGoalEntry.findMany({ where: { userId: fx.userId } })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ goalId: goal.id, kind: 'CONTRIBUTION', note: null })
      expect(entries[0].amount.toString()).toBe('400000')
      expect(entries[0].date.toISOString()).toBe('2026-03-16T00:00:00.000Z')
      // The deprecated column stays exactly as the database defaulted it.
      expect((await storedGoal(fx.userId, goal.id)).currentProgress.toString()).toBe('0')
    })

    it('is ACHIEVED from its first render when the initial amount meets the target', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000_000, initialContribution: 1_000_000 },
        CONTEXT,
      )

      expect(goal.status).toBe('ACHIEVED')
      expect((await storedGoal(fx.userId, goal.id)).status).toBe('ACHIEVED')
    })

    it('treats an initial amount of zero as none', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 0 },
        CONTEXT,
      )

      expect(goal.progress.toString()).toBe('0')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('round-trips a deadline through Postgres as the same calendar date', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, deadline: '2026-12-31' },
        CONTEXT,
      )

      expect(goal.deadline?.toISOString()).toBe('2026-12-31T00:00:00.000Z')
      const stored = await storedGoal(fx.userId, goal.id)
      expect(formatCalendarDate(stored.deadline as Date)).toBe('2026-12-31')
    })

    it('stores a note and a USD currency as given', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { name: 'Trip', targetAmount: 2_500.5, currency: 'USD', note: 'Japan, spring' },
        CONTEXT,
      )

      expect(goal.currency).toBe('USD')
      expect(goal.targetAmount.toString()).toBe('2500.5')
      expect(goal.note).toBe('Japan, spring')
    })

    it('ignores a client-supplied status', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, ...({ status: 'ARCHIVED' } as object) },
        CONTEXT,
      )

      expect(goal.status).toBe('ACTIVE')
    })

    it('rejects an impossible deadline rather than storing a rolled-over date', async () => {
      await expect(
        createSavingsGoal(fx.userId, { ...BASE_INPUT, deadline: '2026-02-30' }, CONTEXT),
      ).rejects.toThrow()

      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it("links to an account: the account's currency, and its derived balance as progress", async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        // USD is asked for and ignored: a linked goal is in its account's currency.
        { ...BASE_INPUT, currency: 'USD', targetAmount: 4_000_000, linkedAccountId: fx.accountId },
        CONTEXT,
      )

      expect(goal.currency).toBe('VND')
      expect(goal.linkedAccountId).toBe(fx.accountId)
      expect(goal.linkedAccount).toEqual({ id: fx.accountId, name: 'Wallet', status: 'ACTIVE' })
      // 5,000,000 initial − 250,000 expense.
      expect(goal.progress.toString()).toBe('4750000')
      expect(goal.status).toBe('ACHIEVED')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('refuses an initial amount on a linked goal, and writes nothing', async () => {
      await expect(
        createSavingsGoal(
          fx.userId,
          { ...BASE_INPUT, linkedAccountId: fx.accountId, initialContribution: 100 },
          CONTEXT,
        ),
      ).rejects.toThrow()

      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('refuses to link a new goal to an archived account', async () => {
      const archived = await createAccount(fx, { name: 'Old', archived: true })

      await expect(
        createSavingsGoal(fx.userId, { ...BASE_INPUT, linkedAccountId: archived.id }, CONTEXT),
      ).rejects.toThrow(ArchivedAccountError)
      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })
  })

  describe('update', () => {
    it('changes name, target, deadline and note, and leaves progress alone', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, deadline: '2026-12-31', initialContribution: 1_000 },
        CONTEXT,
      )

      const updated = await updateSavingsGoal(fx.userId, goal.id, {
        name: 'MacBook Air',
        targetAmount: 40_000_000,
        currency: 'VND',
        deadline: '2027-06-30',
        note: 'Cheaper option',
      })

      expect(updated.name).toBe('MacBook Air')
      expect(updated.targetAmount.toString()).toBe('40000000')
      expect(updated.currency).toBe('VND')
      expect(formatCalendarDate(updated.deadline as Date)).toBe('2027-06-30')
      expect(updated.note).toBe('Cheaper option')
      expect(updated.progress.toString()).toBe('1000')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(1)
    })

    it('changes the currency of a goal that has no entries yet', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      const updated = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        currency: 'USD',
      })

      expect(updated.currency).toBe('USD')
    })

    it('refuses to re-denominate a goal that has entries, by its currency or by a link', async () => {
      const dollars = await createAccount(fx, { name: 'Dollars', currency: 'USD' })
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 2_000_000 },
        CONTEXT,
      )
      const before = await storedGoal(fx.userId, goal.id)

      // 2,000,000 VND recorded must not become 2,000,000 USD.
      await expect(
        updateSavingsGoal(fx.userId, goal.id, { ...BASE_INPUT, currency: 'USD' }),
      ).rejects.toThrow(SavingsGoalCurrencyLockedError)
      await expect(
        updateSavingsGoal(fx.userId, goal.id, { ...BASE_INPUT, linkedAccountId: dollars.id }),
      ).rejects.toThrow(SavingsGoalCurrencyLockedError)

      expect(await storedGoal(fx.userId, goal.id)).toEqual(before)
    })

    it('lets a goal with no entries adopt the currency of the account it links to', async () => {
      const goal = await createSavingsGoal(fx.userId, { ...BASE_INPUT, currency: 'USD' }, CONTEXT)

      const linked = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        currency: 'USD',
        linkedAccountId: fx.accountId,
      })

      expect(linked.currency).toBe('VND')
      expect((await storedGoal(fx.userId, goal.id)).currency).toBe('VND')
    })

    it('reads the goal under its row lock, so a concurrent archive is never undone', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      // The archive commits while the edit is waiting: an edit working from the
      // ACTIVE it read before the archive would write ACTIVE back over it.
      const edit = await raceAgainstHeldWrite(
        (tx) =>
          tx.savingsGoal.update({
            where: { userId_id: { userId: fx.userId, id: goal.id } },
            data: { status: 'ARCHIVED' },
            select: { id: true },
          }),
        () => updateSavingsGoal(fx.userId, goal.id, { ...BASE_INPUT, name: 'Renamed' }),
      )

      expect(edit.status).toBe('rejected')
      expect((edit as PromiseRejectedResult).reason).toBeInstanceOf(SavingsGoalArchivedError)
      const stored = await storedGoal(fx.userId, goal.id)
      expect(stored.status).toBe('ARCHIVED')
      expect(stored.name).toBe('MacBook Pro')
    })

    it('clears a deadline and a note when the fields come back empty', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, deadline: '2026-12-31', note: 'Original' },
        CONTEXT,
      )

      const updated = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        deadline: '',
        note: undefined,
      })

      expect(updated.deadline).toBeNull()
      expect(updated.note).toBeNull()
    })

    it('flips ACHIEVED back to ACTIVE when the target is raised above the derived progress', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000_000, initialContribution: 1_000_000 },
        CONTEXT,
      )
      expect(goal.status).toBe('ACHIEVED')

      const raised = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 2_000_000,
      })

      expect(raised.status).toBe('ACTIVE')
      expect(raised.progress.toString()).toBe('1000000')
      expect((await storedGoal(fx.userId, goal.id)).status).toBe('ACTIVE')
    })

    it('flips ACTIVE to ACHIEVED when the target is lowered to the derived progress', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 2_000_000, initialContribution: 1_000_000 },
        CONTEXT,
      )
      expect(goal.status).toBe('ACTIVE')

      const lowered = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
      })

      expect(lowered.status).toBe('ACHIEVED')
    })

    it('re-derives at the exact Decimal boundary, not at a float one', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { name: 'Boundary', targetAmount: 100.1, currency: 'USD', initialContribution: 100.1 },
        CONTEXT,
      )
      expect(goal.status).toBe('ACHIEVED')

      const justAbove = await updateSavingsGoal(fx.userId, goal.id, {
        name: 'Boundary',
        targetAmount: 100.11,
        currency: 'USD',
      })
      expect(justAbove.status).toBe('ACTIVE')

      const justBelow = await updateSavingsGoal(fx.userId, goal.id, {
        name: 'Boundary',
        targetAmount: 100.09,
        currency: 'USD',
      })
      expect(justBelow.status).toBe('ACHIEVED')
    })

    it('switches the progress source both ways and keeps the entries throughout', async () => {
      const savings = await createAccount(fx, { name: 'Savings', initialBalance: '700000' })
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000_000, initialContribution: 300 },
        CONTEXT,
      )

      const linked = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
        linkedAccountId: savings.id,
      })
      expect(linked.linkedAccount).toEqual({ id: savings.id, name: 'Savings', status: 'ACTIVE' })
      // The progress is the account's balance; the entries wait unchanged.
      expect(linked.currency).toBe('VND')
      expect(linked.progress.toString()).toBe('700000')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(1)

      const unlinked = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
      })
      expect(unlinked.linkedAccount).toBeNull()
      expect(unlinked.linkedAccountId).toBeNull()
      expect(unlinked.progress.toString()).toBe('300')
    })

    it('keeps a link to an account archived since, but refuses a new link to an archived one', async () => {
      const kept = await createAccount(fx, { name: 'Kept' })
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, linkedAccountId: kept.id },
        CONTEXT,
      )
      await prisma.financialAccount.update({
        where: { userId_id: { userId: fx.userId, id: kept.id } },
        data: { status: 'ARCHIVED' },
      })

      // Renaming a goal whose account was archived must not be blocked by it.
      const renamed = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        name: 'Renamed',
        linkedAccountId: kept.id,
      })
      expect(renamed.name).toBe('Renamed')
      expect(renamed.linkedAccount).toEqual({ id: kept.id, name: 'Kept', status: 'ARCHIVED' })

      const other = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)
      await expect(
        updateSavingsGoal(fx.userId, other.id, { ...BASE_INPUT, linkedAccountId: kept.id }),
      ).rejects.toThrow(ArchivedAccountError)
      expect((await storedGoal(fx.userId, other.id)).linkedAccountId).toBeNull()
    })
  })

  describe('linked progress', () => {
    it('follows a transfer into the account, with no write to the goal', async () => {
      const savings = await createAccount(fx, { name: 'Savings' })
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000_000, linkedAccountId: savings.id },
        CONTEXT,
      )
      expect(goal.progress.toString()).toBe('0')
      expect(goal.status).toBe('ACTIVE')
      const before = await storedGoal(fx.userId, goal.id)

      await createTransfer(fx.userId, {
        fromAccountId: fx.accountId,
        toAccountId: savings.id,
        fromAmount: 1_000_000,
        toAmount: 1_000_000,
        date: new Date(Date.now() - 60_000),
      })

      const after = await listed(fx.userId, goal.id)
      expect(after.progress.toString()).toBe('1000000')
      // ACHIEVED is derived from the derived progress on the read itself...
      expect(after.status).toBe('ACHIEVED')
      // ...because nothing wrote to the goal: the stored row is untouched.
      expect(await storedGoal(fx.userId, goal.id)).toEqual(before)
      expect((await listSavingsGoals(fx.userId)).map((row) => row.status)).toEqual(['ACHIEVED'])
    })

    it("renders a linked goal in its account's currency even if the stored copy drifted", async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, linkedAccountId: fx.accountId },
        CONTEXT,
      )
      // Not reachable through the services (the account's currency guard and
      // the link both forbid it); written directly to prove the read does not
      // trust the copy.
      await prisma.savingsGoal.update({
        where: { userId_id: { userId: fx.userId, id: goal.id } },
        data: { currency: 'USD' },
      })

      expect((await listed(fx.userId, goal.id)).currency).toBe('VND')
    })

    it("keeps a followed account's currency fixed through the account service", async () => {
      const fresh = await createAccount(fx, { name: 'Fresh' })
      await createSavingsGoal(fx.userId, { ...BASE_INPUT, linkedAccountId: fresh.id }, CONTEXT)

      await expect(
        updateFinancialAccount(fx.userId, fresh.id, { currency: 'USD' }),
      ).rejects.toThrow(AccountFollowedByGoalError)
    })

    it.each(['create', 'update'] as const)(
      "%s links under the account's row lock, so a concurrent currency change cannot strand the goal in the old currency",
      async (path) => {
        const fresh = await createAccount(fx, { name: 'Fresh' })
        const existing =
          path === 'update' ? await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT) : null

        // The account service's own sequence: lock the account, find no goal
        // following it, change the currency — committed while the link waits.
        const link = await raceAgainstHeldWrite(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "FinancialAccount" WHERE "id" = ${fresh.id} FOR UPDATE`
            await tx.financialAccount.update({
              where: { userId_id: { userId: fx.userId, id: fresh.id } },
              data: { currency: 'USD' },
            })
          },
          () =>
            existing
              ? updateSavingsGoal(fx.userId, existing.id, {
                  ...BASE_INPUT,
                  linkedAccountId: fresh.id,
                })
              : createSavingsGoal(fx.userId, { ...BASE_INPUT, linkedAccountId: fresh.id }, CONTEXT),
        )

        expect(link.status).toBe('fulfilled')
        const goalId = (link as PromiseFulfilledResult<SavingsGoalRow>).value.id
        expect((await storedGoal(fx.userId, goalId)).currency).toBe('USD')
      },
    )

    it('counts only activity up to now, like every current balance', async () => {
      const savings = await createAccount(fx, { name: 'Savings' })
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, linkedAccountId: savings.id },
        CONTEXT,
      )
      await createTransfer(fx.userId, {
        fromAccountId: fx.accountId,
        toAccountId: savings.id,
        fromAmount: 500_000,
        toAmount: 500_000,
        date: new Date('2026-06-01T00:00:00.000Z'),
      })

      expect(
        (
          await listed(fx.userId, goal.id, new Date('2026-05-31T00:00:00.000Z'))
        ).progress.toString(),
      ).toBe('0')
      expect(
        (
          await listed(fx.userId, goal.id, new Date('2026-06-02T00:00:00.000Z'))
        ).progress.toString(),
      ).toBe('500000')
    })

    it('reads two goals on the same account and an unlinked one in one listing', async () => {
      const a = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, name: 'A', linkedAccountId: fx.accountId },
        CONTEXT,
      )
      const b = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, name: 'B', linkedAccountId: fx.accountId },
        CONTEXT,
      )
      const c = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, name: 'C', initialContribution: 42 },
        CONTEXT,
      )

      const rows = await listSavingsGoals(fx.userId)
      const progress = Object.fromEntries(rows.map((row) => [row.id, row.progress.toString()]))
      expect(progress).toEqual({ [a.id]: '4750000', [b.id]: '4750000', [c.id]: '42' })
    })

    it('refuses every entry write on a linked goal', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 500 },
        CONTEXT,
      )
      const [entry] = await prisma.savingsGoalEntry.findMany({ where: { userId: fx.userId } })
      await updateSavingsGoal(fx.userId, goal.id, { ...BASE_INPUT, linkedAccountId: fx.accountId })

      await expect(
        addSavingsGoalEntry(
          fx.userId,
          goal.id,
          {
            kind: 'CONTRIBUTION',
            amount: 1,
            date: '2026-03-01',
          },
          CONTEXT,
        ),
      ).rejects.toThrow(SavingsGoalLinkedError)
      await expect(
        updateSavingsGoalEntry(
          fx.userId,
          entry.id,
          {
            kind: 'CONTRIBUTION',
            amount: 1,
            date: '2026-03-01',
          },
          CONTEXT,
        ),
      ).rejects.toThrow(SavingsGoalLinkedError)
      await expect(deleteSavingsGoalEntry(fx.userId, entry.id)).rejects.toThrow(
        SavingsGoalLinkedError,
      )

      expect(await prisma.savingsGoalEntry.findMany({ where: { userId: fx.userId } })).toEqual([
        entry,
      ])
    })
  })

  describe('entries', () => {
    const contribution = (amount: number, date = '2026-03-01') => ({
      kind: 'CONTRIBUTION' as const,
      amount,
      date,
    })
    const withdrawal = (amount: number, date = '2026-03-02') => ({
      kind: 'WITHDRAWAL' as const,
      amount,
      date,
    })

    it('derives unlinked progress as contributions minus withdrawals', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      const first = await addSavingsGoalEntry(
        fx.userId,
        goal.id,
        {
          ...contribution(1_000_000.5),
          note: 'Salary',
        },
        CONTEXT,
      )
      await addSavingsGoalEntry(fx.userId, goal.id, contribution(250_000, '2026-03-05'), CONTEXT)
      await addSavingsGoalEntry(fx.userId, goal.id, withdrawal(300_000.25, '2026-03-04'), CONTEXT)

      expect(first).toMatchObject({ userId: fx.userId, goalId: goal.id, kind: 'CONTRIBUTION' })
      expect(first.amount.toString()).toBe('1000000.5')
      expect(first.note).toBe('Salary')
      expect(first.date.toISOString()).toBe('2026-03-01T00:00:00.000Z')
      expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('950000.25')
      // The deprecated column is never written.
      expect((await storedGoal(fx.userId, goal.id)).currentProgress.toString()).toBe('0')
    })

    it('lists the history newest first when asked for it', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)
      const older = await addSavingsGoalEntry(
        fx.userId,
        goal.id,
        contribution(10, '2026-03-01'),
        CONTEXT,
      )
      const newer = await addSavingsGoalEntry(
        fx.userId,
        goal.id,
        withdrawal(5, '2026-03-09'),
        CONTEXT,
      )
      const sameDay = await addSavingsGoalEntry(
        fx.userId,
        goal.id,
        contribution(1, '2026-03-09'),
        CONTEXT,
      )

      const [row] = await listSavingsGoals(fx.userId, { entries: true })
      expect(row.entries?.map((entry) => entry.id)).toEqual([sameDay.id, newer.id, older.id])
      // Without the option the listing carries no history at all.
      const [plain] = await listSavingsGoals(fx.userId)
      expect(plain).not.toHaveProperty('entries')
    })

    it('refuses a withdrawal larger than the progress, and writes nothing', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 100 },
        CONTEXT,
      )

      const caught = await captureRejection(
        addSavingsGoalEntry(fx.userId, goal.id, withdrawal(100.01), CONTEXT),
      )

      expect(caught).toBeInstanceOf(SavingsGoalWithdrawalExceedsProgressError)
      expect((caught as SavingsGoalWithdrawalExceedsProgressError).progress.toString()).toBe('100')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(1)
    })

    it('allows a withdrawal down to exactly zero', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 100 },
        CONTEXT,
      )

      await addSavingsGoalEntry(fx.userId, goal.id, withdrawal(100), CONTEXT)

      expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('0')
    })

    it('edits an entry, refusing an edit that would take progress below zero', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)
      const saved = await addSavingsGoalEntry(fx.userId, goal.id, contribution(1_000), CONTEXT)
      await addSavingsGoalEntry(fx.userId, goal.id, withdrawal(600), CONTEXT)

      // Shrinking the contribution below what was already taken out.
      await expect(
        updateSavingsGoalEntry(fx.userId, saved.id, contribution(500), CONTEXT),
      ).rejects.toThrow(SavingsGoalWithdrawalExceedsProgressError)
      // Turning it into a withdrawal is the same mistake, larger.
      await expect(
        updateSavingsGoalEntry(fx.userId, saved.id, withdrawal(1), CONTEXT),
      ).rejects.toThrow(SavingsGoalWithdrawalExceedsProgressError)
      expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('400')

      const edited = await updateSavingsGoalEntry(
        fx.userId,
        saved.id,
        {
          ...contribution(700, '2026-02-20'),
          note: 'Corrected',
        },
        CONTEXT,
      )
      expect(edited.id).toBe(saved.id)
      expect(edited.amount.toString()).toBe('700')
      expect(edited.date.toISOString()).toBe('2026-02-20T00:00:00.000Z')
      expect(edited.note).toBe('Corrected')
      expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('100')
    })

    it('deletes an entry, refusing a delete that would take progress below zero', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)
      const saved = await addSavingsGoalEntry(fx.userId, goal.id, contribution(1_000), CONTEXT)
      const taken = await addSavingsGoalEntry(fx.userId, goal.id, withdrawal(600), CONTEXT)

      await expect(deleteSavingsGoalEntry(fx.userId, saved.id)).rejects.toThrow(
        SavingsGoalWithdrawalExceedsProgressError,
      )

      await deleteSavingsGoalEntry(fx.userId, taken.id)
      expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('1000')
      await deleteSavingsGoalEntry(fx.userId, saved.id)
      expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('0')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('derives ACHIEVED from the entries, on the read and on the stored row', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000 },
        CONTEXT,
      )

      const reach = await addSavingsGoalEntry(fx.userId, goal.id, contribution(1_000), CONTEXT)
      expect((await listed(fx.userId, goal.id)).status).toBe('ACHIEVED')
      expect((await storedGoal(fx.userId, goal.id)).status).toBe('ACHIEVED')

      await addSavingsGoalEntry(fx.userId, goal.id, withdrawal(0.01), CONTEXT)
      expect((await listed(fx.userId, goal.id)).status).toBe('ACTIVE')
      expect((await storedGoal(fx.userId, goal.id)).status).toBe('ACTIVE')

      await updateSavingsGoalEntry(fx.userId, reach.id, contribution(1_000.01), CONTEXT)
      expect((await listed(fx.userId, goal.id)).status).toBe('ACHIEVED')
    })

    it('refuses every entry write on an archived goal', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 500 },
        CONTEXT,
      )
      const [entry] = await prisma.savingsGoalEntry.findMany({ where: { userId: fx.userId } })
      await archiveSavingsGoal(fx.userId, goal.id)

      await expect(
        addSavingsGoalEntry(fx.userId, goal.id, contribution(1), CONTEXT),
      ).rejects.toThrow(SavingsGoalArchivedError)
      await expect(
        updateSavingsGoalEntry(fx.userId, entry.id, contribution(1), CONTEXT),
      ).rejects.toThrow(SavingsGoalArchivedError)
      await expect(deleteSavingsGoalEntry(fx.userId, entry.id)).rejects.toThrow(
        SavingsGoalArchivedError,
      )
      expect(await prisma.savingsGoalEntry.findMany({ where: { userId: fx.userId } })).toEqual([
        entry,
      ])
    })

    it('refuses an entry dated after today in the user zone, on add and on edit', async () => {
      // 20:00 UTC on the 15th is already the 16th in Ho Chi Minh City.
      const now = new Date('2026-03-15T20:00:00.000Z')
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      const today = await addSavingsGoalEntry(
        fx.userId,
        goal.id,
        contribution(10, '2026-03-16'),
        CONTEXT,
        now,
      )
      await expect(
        addSavingsGoalEntry(fx.userId, goal.id, contribution(10, '2026-03-17'), CONTEXT, now),
      ).rejects.toThrow('The date cannot be later than today')
      await expect(
        updateSavingsGoalEntry(fx.userId, today.id, contribution(10, '2026-03-17'), CONTEXT, now),
      ).rejects.toThrow('The date cannot be later than today')

      const stored = await prisma.savingsGoalEntry.findMany({ where: { userId: fx.userId } })
      expect(stored).toEqual([today])
    })

    it('rejects an invalid entry before writing anything', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      for (const input of [
        contribution(0),
        contribution(-5),
        contribution(1, '2026-02-30'),
        { ...contribution(1), kind: 'GIFT' },
      ]) {
        await expect(
          addSavingsGoalEntry(
            fx.userId,
            goal.id,
            input as ReturnType<typeof contribution>,
            CONTEXT,
          ),
        ).rejects.toThrow()
      }
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('lets only one of two concurrent withdrawals through when both would fit alone', async () => {
      // Three runs, because a race that passes once may simply have been
      // scheduled kindly. Each run is a fresh goal.
      for (const run of [1, 2, 3]) {
        const goal = await createSavingsGoal(
          fx.userId,
          { ...BASE_INPUT, name: `Race ${run}`, initialContribution: 100 },
          CONTEXT,
        )

        // 60 each: either alone fits inside 100, both together do not. Without
        // the goal row lock both would read the same progress, both would pass,
        // and the goal would end at −20.
        const results = await Promise.allSettled([
          addSavingsGoalEntry(fx.userId, goal.id, withdrawal(60), CONTEXT),
          addSavingsGoalEntry(fx.userId, goal.id, withdrawal(60), CONTEXT),
        ])

        const rejected = results.filter((result) => result.status === 'rejected')
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0].reason).toBeInstanceOf(SavingsGoalWithdrawalExceedsProgressError)
        // The loser saw the winner's committed withdrawal, not the pre-race state.
        expect(
          (rejected[0].reason as SavingsGoalWithdrawalExceedsProgressError).progress.toString(),
        ).toBe('40')
        expect((await listed(fx.userId, goal.id)).progress.toString()).toBe('40')
      }
    }, 30_000)
  })

  describe('archive', () => {
    it('sets ARCHIVED and keeps the row and its entries readable', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, initialContribution: 10 },
        CONTEXT,
      )

      const archived = await archiveSavingsGoal(fx.userId, goal.id)

      expect(archived.status).toBe('ARCHIVED')
      expect(archived).not.toHaveProperty('currentProgress')
      const row = await listed(fx.userId, goal.id)
      expect(row.status).toBe('ARCHIVED')
      expect(row.progress.toString()).toBe('10')
    })

    it('refuses an edit afterwards', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)
      await archiveSavingsGoal(fx.userId, goal.id)

      await expect(
        updateSavingsGoal(fx.userId, goal.id, { ...BASE_INPUT, name: 'Renamed' }),
      ).rejects.toThrow(SavingsGoalArchivedError)

      const stored = await storedGoal(fx.userId, goal.id)
      expect(stored.name).toBe('MacBook Pro')
      expect(stored.status).toBe('ARCHIVED')
    })

    it('is a no-op when the goal is already archived', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)
      const first = await archiveSavingsGoal(fx.userId, goal.id)

      const second = await archiveSavingsGoal(fx.userId, goal.id)

      expect(second.status).toBe('ARCHIVED')
      expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime())
    })

    it('does not un-archive a goal whose progress passes its target', async () => {
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 100, linkedAccountId: fx.accountId },
        CONTEXT,
      )
      await archiveSavingsGoal(fx.userId, goal.id)

      // The arithmetic says ACHIEVED; the user's decision outranks it.
      expect((await listed(fx.userId, goal.id)).status).toBe('ARCHIVED')
    })
  })

  describe('listing', () => {
    it('excludes archived goals and puts in-progress ones first', async () => {
      const active = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Active' }, CONTEXT)
      const achieved = await createSavingsGoal(
        fx.userId,
        { name: 'Achieved', targetAmount: 100, currency: 'VND', initialContribution: 100 },
        CONTEXT,
      )
      const alsoActive = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, name: 'Also active' },
        CONTEXT,
      )
      const gone = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Archived' }, CONTEXT)
      await archiveSavingsGoal(fx.userId, gone.id)

      const rows = await listSavingsGoals(fx.userId)

      expect(rows.map((g) => g.name)).toEqual(['Active', 'Also active', 'Achieved'])
      expect(rows.map((g) => g.id)).toEqual([active.id, alsoActive.id, achieved.id])
    })

    it('ranks by the DERIVED status, so a goal its account carried past the target sorts as achieved', async () => {
      const savings = await createAccount(fx, { name: 'Savings' })
      const linked = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, name: 'Linked', targetAmount: 100, linkedAccountId: savings.id },
        CONTEXT,
      )
      const later = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Later' }, CONTEXT)
      expect((await listSavingsGoals(fx.userId)).map((g) => g.id)).toEqual([linked.id, later.id])

      await createTransfer(fx.userId, {
        fromAccountId: fx.accountId,
        toAccountId: savings.id,
        fromAmount: 100,
        toAmount: 100,
        date: new Date(Date.now() - 60_000),
      })

      expect((await listSavingsGoals(fx.userId)).map((g) => g.id)).toEqual([later.id, linked.id])
    })

    it('includes every status, oldest first, for the archived section', async () => {
      const first = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'First' }, CONTEXT)
      const second = await createSavingsGoal(
        fx.userId,
        { name: 'Second', targetAmount: 100, currency: 'VND', initialContribution: 100 },
        CONTEXT,
      )
      const third = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Third' }, CONTEXT)
      await archiveSavingsGoal(fx.userId, first.id)

      const all = await listAllSavingsGoals(fx.userId)

      expect(all.map((g) => `${g.name}:${g.status}`)).toEqual([
        'First:ARCHIVED',
        'Second:ACHIEVED',
        'Third:ACTIVE',
      ])
      expect(all.map((g) => g.id)).toEqual([first.id, second.id, third.id])
    })

    it('returns nothing for a user with no goals', async () => {
      expect(await listSavingsGoals(fx.userId)).toEqual([])
      expect(await listAllSavingsGoals(fx.userId, { entries: true })).toEqual([])
    })
  })

  describe('tenant isolation', () => {
    it("refuses every mutation on another user's goal and entries, and leaves them identical", async () => {
      const other = await createGoalUser()
      extraUserIds.push(other.userId)
      const theirs = await createSavingsGoal(
        other.userId,
        {
          name: 'Their goal',
          targetAmount: 9_000_000,
          currency: 'VND',
          initialContribution: 1_000,
          deadline: '2027-01-31',
          note: 'Theirs',
        },
        CONTEXT,
      )
      const theirGoal = await storedGoal(other.userId, theirs.id)
      const theirEntries = await prisma.savingsGoalEntry.findMany({
        where: { userId: other.userId },
      })
      expect(theirEntries).toHaveLength(1)

      await expectPrismaCode(
        updateSavingsGoal(fx.userId, theirs.id, { ...BASE_INPUT, name: 'Stolen' }),
        'P2025',
      )
      await expectPrismaCode(archiveSavingsGoal(fx.userId, theirs.id), 'P2025')
      await expectPrismaCode(
        addSavingsGoalEntry(
          fx.userId,
          theirs.id,
          {
            kind: 'WITHDRAWAL',
            amount: 1,
            date: '2026-03-01',
          },
          CONTEXT,
        ),
        'P2025',
      )
      await expectPrismaCode(
        updateSavingsGoalEntry(
          fx.userId,
          theirEntries[0].id,
          {
            kind: 'CONTRIBUTION',
            amount: 9_000_000,
            date: '2026-03-01',
          },
          CONTEXT,
        ),
        'P2025',
      )
      await expectPrismaCode(deleteSavingsGoalEntry(fx.userId, theirEntries[0].id), 'P2025')

      expect(await storedGoal(other.userId, theirs.id)).toEqual(theirGoal)
      expect(await prisma.savingsGoalEntry.findMany({ where: { userId: other.userId } })).toEqual(
        theirEntries,
      )
    })

    it("refuses to link a goal to another user's account", async () => {
      const other = await createGoalUser()
      extraUserIds.push(other.userId)
      const mine = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      await expectPrismaCode(
        createSavingsGoal(fx.userId, { ...BASE_INPUT, linkedAccountId: other.accountId }, CONTEXT),
        'P2025',
      )
      await expectPrismaCode(
        updateSavingsGoal(fx.userId, mine.id, { ...BASE_INPUT, linkedAccountId: other.accountId }),
        'P2025',
      )

      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(1)
      expect((await storedGoal(fx.userId, mine.id)).linkedAccountId).toBeNull()
    })

    it("never lists another user's goals, nor counts their entries or balances", async () => {
      const other = await createGoalUser()
      extraUserIds.push(other.userId)
      const theirActive = await createSavingsGoal(
        other.userId,
        { ...BASE_INPUT, initialContribution: 7 },
        CONTEXT,
      )
      const theirArchived = await createSavingsGoal(other.userId, BASE_INPUT, CONTEXT)
      await archiveSavingsGoal(other.userId, theirArchived.id)
      await createSavingsGoal(
        other.userId,
        { ...BASE_INPUT, linkedAccountId: other.accountId },
        CONTEXT,
      )
      const mine = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Mine' }, CONTEXT)

      for (const list of [
        await listSavingsGoals(fx.userId, { entries: true }),
        await listAllSavingsGoals(fx.userId, { entries: true }),
      ]) {
        expect(list.map((g) => g.id)).toEqual([mine.id])
        expect(list[0].progress.toString()).toBe('0')
        expect(list[0].entries).toEqual([])
      }
      expect(await listSavingsGoals(other.userId)).toHaveLength(2)
      expect(await listAllSavingsGoals(other.userId)).toHaveLength(3)
      expect((await listed(other.userId, theirActive.id)).progress.toString()).toBe('7')
    })
  })

  describe('database constraints', () => {
    it('rejects a zero or negative target even bypassing the service', async () => {
      for (const targetAmount of ['0', '-1']) {
        const caught = await captureRejection(
          prisma.savingsGoal.create({
            data: {
              userId: fx.userId,
              name: 'Bad target',
              targetAmount: new Prisma.Decimal(targetAmount),
              currency: 'VND',
            },
          }),
        )
        expect(String(caught)).toContain('SavingsGoal_targetAmount_positive')
      }

      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('rejects a negative entry amount even bypassing the service', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      const caught = await captureRejection(
        prisma.savingsGoalEntry.create({
          data: {
            userId: fx.userId,
            goalId: goal.id,
            kind: 'CONTRIBUTION',
            amount: new Prisma.Decimal('-0.01'),
            date: new Date('2026-03-01T00:00:00.000Z'),
          },
        }),
      )

      expect(String(caught)).toContain('SavingsGoalEntry_amount_nonnegative')
      expect(await prisma.savingsGoalEntry.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it("cannot point an entry at another user's goal, or a goal at another user's account", async () => {
      const other = await createGoalUser()
      extraUserIds.push(other.userId)
      const theirs = await createSavingsGoal(other.userId, BASE_INPUT, CONTEXT)
      const mine = await createSavingsGoal(fx.userId, BASE_INPUT, CONTEXT)

      await expectPrismaCode(
        prisma.savingsGoalEntry.create({
          data: {
            userId: fx.userId,
            goalId: theirs.id,
            kind: 'CONTRIBUTION',
            amount: new Prisma.Decimal('1'),
            date: new Date('2026-03-01T00:00:00.000Z'),
          },
        }),
        'P2003',
      )
      await expectPrismaCode(
        prisma.savingsGoal.update({
          where: { userId_id: { userId: fx.userId, id: mine.id } },
          data: { linkedAccountId: other.accountId },
        }),
        'P2003',
      )
    })
  })

  describe('no money moves', () => {
    it('leaves accounts, transactions, transfers and the balance untouched by every mutation', async () => {
      const before = {
        accounts: await prisma.financialAccount.count({ where: { userId: fx.userId } }),
        transactions: await prisma.transaction.count({ where: { userId: fx.userId } }),
        transfers: await prisma.transfer.count({ where: { userId: fx.userId } }),
        balance: (await getAccountBalance(fx.userId, fx.accountId)).toString(),
        account: await prisma.financialAccount.findUniqueOrThrow({
          where: { userId_id: { userId: fx.userId, id: fx.accountId } },
        }),
        transaction: await prisma.transaction.findUniqueOrThrow({
          where: { userId_id: { userId: fx.userId, id: fx.transactionId } },
        }),
      }
      expect(before.balance).toBe('4750000')

      // Every mutation the service has: entries on an unlinked goal, then a
      // link to the very account whose balance is checked, then an archive.
      const goal = await createSavingsGoal(
        fx.userId,
        { ...BASE_INPUT, targetAmount: 1_000_000, initialContribution: 250_000 },
        CONTEXT,
      )
      const entry = await addSavingsGoalEntry(
        fx.userId,
        goal.id,
        {
          kind: 'CONTRIBUTION',
          amount: 900_000,
          date: '2026-03-01',
        },
        CONTEXT,
      )
      await updateSavingsGoalEntry(
        fx.userId,
        entry.id,
        {
          kind: 'CONTRIBUTION',
          amount: 800_000,
          date: '2026-03-01',
        },
        CONTEXT,
      )
      await deleteSavingsGoalEntry(fx.userId, entry.id)
      await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        linkedAccountId: fx.accountId,
      })
      await archiveSavingsGoal(fx.userId, goal.id)
      await listSavingsGoals(fx.userId, { entries: true })
      await listAllSavingsGoals(fx.userId, { entries: true })

      expect(await prisma.financialAccount.count({ where: { userId: fx.userId } })).toBe(
        before.accounts,
      )
      expect(await prisma.transaction.count({ where: { userId: fx.userId } })).toBe(
        before.transactions,
      )
      expect(await prisma.transfer.count({ where: { userId: fx.userId } })).toBe(before.transfers)
      expect((await getAccountBalance(fx.userId, fx.accountId)).toString()).toBe(before.balance)
      expect(
        await prisma.financialAccount.findUniqueOrThrow({
          where: { userId_id: { userId: fx.userId, id: fx.accountId } },
        }),
      ).toEqual(before.account)
      expect(
        await prisma.transaction.findUniqueOrThrow({
          where: { userId_id: { userId: fx.userId, id: fx.transactionId } },
        }),
      ).toEqual(before.transaction)
    })

    /**
     * The structural half of "no money moves": the service READS a balance for
     * a linked goal (`./balance-timeline`), but imports nothing that could write to the
     * ledger or reach a live rate. Matched on import specifiers ending in the
     * module name, relative or aliased, so the doc comment may name them.
     */
    it('imports nothing that could move money or reach a live rate', () => {
      const source = readFileSync(
        fileURLToPath(new URL('./savings-goal.ts', import.meta.url)),
        'utf8',
      )

      for (const forbidden of [
        'transaction',
        'transfer',
        'linked-transaction',
        'financial-account',
        'current-rate-policy',
        'fx-service',
        'current-amount',
        'historical-amount',
      ]) {
        expect(source).not.toMatch(new RegExp(`from '[^']*/${forbidden}'`))
      }
    })
  })
})

/**
 * The idempotent data backfill in the `savings_goal_entries` migration (spec
 * 2026-10-12 §5): every goal that had a typed-in `currentProgress > 0` and no
 * entries yet gets one CONTRIBUTION of that amount, dated the calendar day of
 * its `updatedAt` in its owner's zone, so the derived progress equals the
 * figure the user last saw.
 *
 * Only that statement is run — the DDL around it is already applied to the
 * test database — twice, inside a transaction that is then rolled back, so the
 * rest of the shared database is left as it was.
 */
describe('savings_goal_entries migration backfill', () => {
  const userIds: string[] = []

  afterEach(async () => {
    await cleanupUsers(userIds.splice(0))
  })

  async function user(timezone: string): Promise<string> {
    const id = randomUUID()
    await prisma.user.create({
      data: { id, email: `goal-backfill-${id}@example.com`, name: 'Backfill', timezone },
    })
    userIds.push(id)
    return id
  }

  /** A goal written the way the pre-linking app wrote it: progress in the column. */
  async function legacyGoal(userId: string, currentProgress: string): Promise<string> {
    const goal = await prisma.savingsGoal.create({
      data: {
        userId,
        name: `Legacy ${currentProgress}`,
        targetAmount: new Prisma.Decimal('1000000'),
        currentProgress: new Prisma.Decimal(currentProgress),
        currency: 'VND',
      },
    })
    return goal.id
  }

  it('gives each legacy goal exactly one opening contribution, even when run twice', async () => {
    const statements = splitSqlStatements(readMigrationSql('savings_goal_entries')).filter(
      (statement) => statement.startsWith('INSERT INTO "SavingsGoalEntry"'),
    )
    expect(statements).toHaveLength(1)

    const vietnam = await user('Asia/Ho_Chi_Minh')
    const unknownZone = await user('Not/A_Zone')
    const saved = await legacyGoal(vietnam, '250000.50')
    const untouched = await legacyGoal(vietnam, '0')
    const alreadyMigrated = await legacyGoal(vietnam, '500')
    const kept = await prisma.savingsGoalEntry.create({
      data: {
        userId: vietnam,
        goalId: alreadyMigrated,
        kind: 'WITHDRAWAL',
        amount: new Prisma.Decimal('1'),
        date: new Date('2026-01-01T00:00:00.000Z'),
      },
    })
    const fallback = await legacyGoal(unknownZone, '42')

    const rollback = new Error('roll back the migration run')
    await expect(
      prisma.$transaction(async (tx) => {
        // 20:00 UTC on the 10th is 03:00 on the 11th in Ho Chi Minh City.
        await tx.$executeRaw`
          UPDATE "SavingsGoal" SET "updatedAt" = ${new Date('2026-09-10T20:00:00.000Z')}
          WHERE "id" IN (${Prisma.join([saved, untouched, alreadyMigrated, fallback])})`
        for (let run = 0; run < 2; run++) await tx.$executeRawUnsafe(statements[0])

        const entries = await tx.savingsGoalEntry.findMany({
          where: { userId: { in: [vietnam, unknownZone] } },
        })
        const forGoal = (goalId: string) => entries.filter((entry) => entry.goalId === goalId)

        expect(forGoal(saved)).toHaveLength(1)
        expect(forGoal(saved)[0]).toMatchObject({
          userId: vietnam,
          kind: 'CONTRIBUTION',
          note: null,
        })
        expect(forGoal(saved)[0].amount.toString()).toBe('250000.5')
        expect(forGoal(saved)[0].id).toMatch(/^c[0-9a-f]{32}$/)
        // The user's calendar day, as a UTC-midnight carrier.
        expect(forGoal(saved)[0].date.toISOString()).toBe('2026-09-11T00:00:00.000Z')
        // Nothing saved, nothing to record.
        expect(forGoal(untouched)).toEqual([])
        // A goal that already has entries is left exactly as it is.
        expect(forGoal(alreadyMigrated)).toEqual([kept])
        // A zone the database does not know falls back to the UTC day rather
        // than failing the migration.
        expect(forGoal(fallback)).toHaveLength(1)
        expect(forGoal(fallback)[0].date.toISOString()).toBe('2026-09-10T00:00:00.000Z')
        throw rollback
      }),
    ).rejects.toBe(rollback)
  })
})
