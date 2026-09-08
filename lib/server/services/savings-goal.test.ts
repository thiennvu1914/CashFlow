import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { formatCalendarDate } from '@/lib/datetime/calendar-date'
import { getAccountBalance } from '@/lib/server/services/balance'
import {
  archiveSavingsGoal,
  createSavingsGoal,
  deriveSavingsGoalStatus,
  listAllSavingsGoals,
  listSavingsGoals,
  updateSavingsGoal,
  updateSavingsGoalProgress,
  SavingsGoalArchivedError,
} from './savings-goal'

/**
 * Group 1's data-layer acceptance check (spec §4.8).
 *
 * Five properties are what this suite exists to hold:
 *
 * 1. **Nothing here moves money.** The fixture seeds an account and an EXPENSE
 *    transaction, and the "no account mutation" case runs *every* mutation in
 *    the service before re-asserting the account/transaction/transfer counts
 *    and the account's derived balance. A stray write to any of them fails it.
 * 2. **ACHIEVED is derived on every write.** The boundary is exercised on the
 *    exact `Decimal` (target 100.10 against progress 100.10 and 100.09), which
 *    is the case a `toNumber()` comparison can flip, and in both directions —
 *    raising a target un-achieves a goal, lowering it re-achieves one.
 * 3. **ARCHIVED is terminal but archiving is idempotent.** Edits and progress
 *    updates on an archived goal throw; archiving one again is a no-op that
 *    does not even bump `updatedAt`.
 * 4. **A calendar deadline survives the round trip.** A deadline written as
 *    `2026-12-31` comes back out of Postgres as `2026-12-31` — at UTC midnight,
 *    never shifted by the server's or the user's zone.
 * 5. **Every query is tenant-scoped.** A second user's goal is targeted by each
 *    mutation, which must fail with P2025 and leave the row byte-identical.
 *
 * `fetch` is a throwing spy for every test and `afterEach` asserts it was never
 * called: a savings goal has no FX dimension at all (each goal keeps its own
 * currency), so any network access here would be a bug rather than a slow test.
 */

/** UTC+7, no DST — so no wall-clock assertion below depends on a DST date. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

interface GoalFixture {
  userId: string
  accountId: string
  transactionId: string
}

/**
 * A user with one account and one expense already recorded.
 *
 * The account and the transaction exist purely so the "no account mutation"
 * case has something that *could* be corrupted: with an empty ledger, "counts
 * unchanged" and "balance unchanged" would both hold trivially.
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
  return { userId: user.id, accountId: account.id, transactionId: transaction.id }
}

/** Deletes a user's rows in FK order, then the user. */
async function cleanupUsers(userIds: string[]) {
  if (userIds.length === 0) return
  try {
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
    // The stored status is not consulted except for ARCHIVED: a goal whose
    // target was just raised is ACTIVE again, however it was stored.
    expect(deriveSavingsGoalStatus(d('100'), d('200'), 'ACHIEVED')).toBe('ACTIVE')
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
    it('defaults progress to 0, starts ACTIVE, and stores no deadline', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT)

      expect(goal.name).toBe('MacBook Pro')
      expect(goal.targetAmount.toString()).toBe('50000000')
      expect(goal.currentProgress.toString()).toBe('0')
      expect(goal.currency).toBe('VND')
      expect(goal.status).toBe('ACTIVE')
      expect(goal.deadline).toBeNull()
      expect(goal.note).toBeNull()
      expect(goal.userId).toBe(fx.userId)
    })

    it('round-trips a deadline through Postgres as the same calendar date', async () => {
      const goal = await createSavingsGoal(fx.userId, { ...BASE_INPUT, deadline: '2026-12-31' })

      // Not 2026-12-30T17:00Z (the +07 midnight) and not the 30th read back:
      // the stored instant's UTC components ARE the calendar date the user
      // picked, in every zone.
      expect(goal.deadline?.toISOString()).toBe('2026-12-31T00:00:00.000Z')
      expect(formatCalendarDate(goal.deadline as Date)).toBe('2026-12-31')

      const stored = await prisma.savingsGoal.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: goal.id } },
      })
      expect(formatCalendarDate(stored.deadline as Date)).toBe('2026-12-31')
    })

    it('is ACHIEVED immediately when the starting progress already meets the target', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
        currentProgress: 1_000_000,
      })

      expect(goal.status).toBe('ACHIEVED')
      expect(goal.currentProgress.toString()).toBe('1000000')
    })

    it('stores a note and a USD currency as given', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        name: 'Trip',
        targetAmount: 2_500.5,
        currency: 'USD',
        note: 'Japan, spring',
      })

      expect(goal.currency).toBe('USD')
      expect(goal.targetAmount.toString()).toBe('2500.5')
      expect(goal.note).toBe('Japan, spring')
    })

    it('ignores a client-supplied status', async () => {
      // Zod strips it and the service writes a derived status regardless, so a
      // crafted request cannot mark an unmet goal ACHIEVED or archive one.
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        ...({ status: 'ARCHIVED' } as object),
      })

      expect(goal.status).toBe('ACTIVE')
    })

    it('rejects an impossible deadline rather than storing a rolled-over date', async () => {
      await expect(
        createSavingsGoal(fx.userId, { ...BASE_INPUT, deadline: '2026-02-30' }),
      ).rejects.toThrow()

      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })
  })

  describe('update', () => {
    it('changes name, target, currency, deadline and note', async () => {
      const goal = await createSavingsGoal(fx.userId, { ...BASE_INPUT, deadline: '2026-12-31' })

      const updated = await updateSavingsGoal(fx.userId, goal.id, {
        name: 'MacBook Air',
        targetAmount: 40_000_000,
        currency: 'USD',
        deadline: '2027-06-30',
        note: 'Cheaper option',
      })

      expect(updated.name).toBe('MacBook Air')
      expect(updated.targetAmount.toString()).toBe('40000000')
      expect(updated.currency).toBe('USD')
      expect(formatCalendarDate(updated.deadline as Date)).toBe('2027-06-30')
      expect(updated.note).toBe('Cheaper option')
      // Progress is not the edit form's business.
      expect(updated.currentProgress.toString()).toBe('0')
    })

    it('clears a deadline and a note when the fields come back empty', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        deadline: '2026-12-31',
        note: 'Original',
      })

      const updated = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        deadline: '',
        note: undefined,
      })

      // The absence has to be *written*: skipping the field would leave the old
      // deadline in place, so a user could never remove one.
      expect(updated.deadline).toBeNull()
      expect(updated.note).toBeNull()
    })

    it('flips ACHIEVED back to ACTIVE when the target is raised above the progress', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
        currentProgress: 1_000_000,
      })
      expect(goal.status).toBe('ACHIEVED')

      const raised = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 2_000_000,
      })

      expect(raised.status).toBe('ACTIVE')
      // The progress itself is untouched — only the verdict changed.
      expect(raised.currentProgress.toString()).toBe('1000000')
    })

    it('flips ACTIVE to ACHIEVED when the target is lowered to the progress', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        targetAmount: 2_000_000,
        currentProgress: 1_000_000,
      })
      expect(goal.status).toBe('ACTIVE')

      const lowered = await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
      })

      expect(lowered.status).toBe('ACHIEVED')
    })

    it('re-derives at the exact Decimal boundary, not at a float one', async () => {
      // Progress 100.10 against targets 100.10 and 100.09/100.11: the same
      // boundary `deriveSavingsGoalStatus` is unit-tested on, this time all the
      // way through Postgres, so the column's own scale is in the loop too.
      const goal = await createSavingsGoal(fx.userId, {
        name: 'Boundary',
        targetAmount: 100.1,
        currency: 'USD',
        currentProgress: 100.1,
      })
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
  })

  describe('progress', () => {
    it('marks a goal ACHIEVED at exactly the target', async () => {
      const goal = await createSavingsGoal(fx.userId, { ...BASE_INPUT, targetAmount: 1_000_000 })

      const halfway = await updateSavingsGoalProgress(fx.userId, goal.id, {
        currentProgress: 500_000,
      })
      expect(halfway.status).toBe('ACTIVE')
      expect(halfway.currentProgress.toString()).toBe('500000')

      const met = await updateSavingsGoalProgress(fx.userId, goal.id, {
        currentProgress: 1_000_000,
      })
      expect(met.status).toBe('ACHIEVED')
    })

    it('stores over-saved progress as given rather than clamping it', async () => {
      const goal = await createSavingsGoal(fx.userId, { ...BASE_INPUT, targetAmount: 1_000_000 })

      const over = await updateSavingsGoalProgress(fx.userId, goal.id, {
        currentProgress: 1_200_000,
      })

      // Clamping happens only in the DTO's progress *bar*: the figure the user
      // typed is not the service's to round down.
      expect(over.currentProgress.toString()).toBe('1200000')
      expect(over.status).toBe('ACHIEVED')
    })

    it('accepts a reduction back to zero, which un-achieves the goal', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
        currentProgress: 1_000_000,
      })
      expect(goal.status).toBe('ACHIEVED')

      const spent = await updateSavingsGoalProgress(fx.userId, goal.id, { currentProgress: 0 })

      expect(spent.currentProgress.toString()).toBe('0')
      expect(spent.status).toBe('ACTIVE')
    })
  })

  describe('archive', () => {
    it('sets ARCHIVED and keeps the row readable', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT)

      const archived = await archiveSavingsGoal(fx.userId, goal.id)

      expect(archived.status).toBe('ARCHIVED')
      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId, id: goal.id } })).toBe(1)
    })

    it('refuses an edit or a progress update afterwards', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT)
      await archiveSavingsGoal(fx.userId, goal.id)

      await expect(
        updateSavingsGoal(fx.userId, goal.id, { ...BASE_INPUT, name: 'Renamed' }),
      ).rejects.toThrow(SavingsGoalArchivedError)
      await expect(
        updateSavingsGoalProgress(fx.userId, goal.id, { currentProgress: 1 }),
      ).rejects.toThrow(SavingsGoalArchivedError)

      const stored = await prisma.savingsGoal.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: goal.id } },
      })
      expect(stored.name).toBe('MacBook Pro')
      expect(stored.currentProgress.toString()).toBe('0')
      expect(stored.status).toBe('ARCHIVED')
    })

    it('is a no-op when the goal is already archived', async () => {
      const goal = await createSavingsGoal(fx.userId, BASE_INPUT)
      const first = await archiveSavingsGoal(fx.userId, goal.id)

      const second = await archiveSavingsGoal(fx.userId, goal.id)

      expect(second.status).toBe('ARCHIVED')
      // A true no-op: no write happened, so `updatedAt` did not move. A
      // double-click on Archive is the same request that already succeeded.
      expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime())
    })

    it('does not un-archive a goal whose progress passes its target', async () => {
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        targetAmount: 100,
        currentProgress: 500,
      })
      await archiveSavingsGoal(fx.userId, goal.id)

      const stored = await prisma.savingsGoal.findUniqueOrThrow({
        where: { userId_id: { userId: fx.userId, id: goal.id } },
      })
      // The arithmetic says ACHIEVED; the user's decision outranks it.
      expect(stored.status).toBe('ARCHIVED')
    })
  })

  describe('listing', () => {
    it('excludes archived goals and puts in-progress ones first', async () => {
      const active = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Active' })
      const achieved = await createSavingsGoal(fx.userId, {
        name: 'Achieved',
        targetAmount: 100,
        currency: 'VND',
        currentProgress: 100,
      })
      const alsoActive = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Also active' })
      const gone = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Archived' })
      await archiveSavingsGoal(fx.userId, gone.id)

      const listed = await listSavingsGoals(fx.userId)

      // ACTIVE before ACHIEVED, and within a status the creation order — even
      // though 'Achieved' was created second.
      expect(listed.map((g) => g.name)).toEqual(['Active', 'Also active', 'Achieved'])
      expect(listed.map((g) => g.id)).not.toContain(gone.id)
      expect(listed.map((g) => g.id)).toEqual([active.id, alsoActive.id, achieved.id])
    })

    it('includes every status, oldest first, for the archived section', async () => {
      const first = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'First' })
      const second = await createSavingsGoal(fx.userId, {
        name: 'Second',
        targetAmount: 100,
        currency: 'VND',
        currentProgress: 100,
      })
      const third = await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Third' })
      await archiveSavingsGoal(fx.userId, first.id)

      const all = await listAllSavingsGoals(fx.userId)

      // A history reads in the order things happened — not status-ranked.
      expect(all.map((g) => `${g.name}:${g.status}`)).toEqual([
        'First:ARCHIVED',
        'Second:ACHIEVED',
        'Third:ACTIVE',
      ])
      expect(all.map((g) => g.id)).toEqual([first.id, second.id, third.id])
    })

    it('returns nothing for a user with no goals', async () => {
      expect(await listSavingsGoals(fx.userId)).toEqual([])
      expect(await listAllSavingsGoals(fx.userId)).toEqual([])
    })
  })

  describe('tenant isolation', () => {
    it("refuses every mutation on another user's goal and leaves the row identical", async () => {
      const other = await createGoalUser()
      extraUserIds.push(other.userId)
      const theirs = await createSavingsGoal(other.userId, {
        name: 'Their goal',
        targetAmount: 9_000_000,
        currency: 'VND',
        currentProgress: 1_000,
        deadline: '2027-01-31',
        note: 'Theirs',
      })

      await expectPrismaCode(
        updateSavingsGoal(fx.userId, theirs.id, { ...BASE_INPUT, name: 'Stolen' }),
        'P2025',
      )
      await expectPrismaCode(
        updateSavingsGoalProgress(fx.userId, theirs.id, { currentProgress: 9_000_000 }),
        'P2025',
      )
      await expectPrismaCode(archiveSavingsGoal(fx.userId, theirs.id), 'P2025')

      const stored = await prisma.savingsGoal.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
      })
      // Byte-identical, `updatedAt` included: not one of the three attempts
      // reached a write.
      expect(stored).toEqual(theirs)
    })

    it("never lists another user's goals", async () => {
      const other = await createGoalUser()
      extraUserIds.push(other.userId)
      // The other user's goals are identical in every respect except ownership,
      // and cover all three statuses so no list or filter can leak one.
      const theirActive = await createSavingsGoal(other.userId, BASE_INPUT)
      const theirArchived = await createSavingsGoal(other.userId, BASE_INPUT)
      await archiveSavingsGoal(other.userId, theirArchived.id)
      await createSavingsGoal(fx.userId, { ...BASE_INPUT, name: 'Mine' })

      const mine = await listSavingsGoals(fx.userId)
      const allMine = await listAllSavingsGoals(fx.userId)

      for (const list of [mine, allMine]) {
        expect(list.map((g) => g.userId)).toEqual([fx.userId])
        expect(list.map((g) => g.id)).not.toContain(theirActive.id)
        expect(list.map((g) => g.id)).not.toContain(theirArchived.id)
      }
      // And symmetrically: their own read is unaffected by ours.
      expect(await listSavingsGoals(other.userId)).toHaveLength(1)
      expect(await listAllSavingsGoals(other.userId)).toHaveLength(2)
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
        // The CHECK's own name, so a migration that dropped it fails here
        // rather than passing quietly.
        expect(String(caught)).toContain('SavingsGoal_targetAmount_positive')
      }

      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('rejects negative progress even bypassing the service', async () => {
      const caught = await captureRejection(
        prisma.savingsGoal.create({
          data: {
            userId: fx.userId,
            name: 'Bad progress',
            targetAmount: new Prisma.Decimal('100'),
            currentProgress: new Prisma.Decimal('-1'),
            currency: 'VND',
          },
        }),
      )

      expect(String(caught)).toContain('SavingsGoal_currentProgress_nonnegative')
      expect(await prisma.savingsGoal.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('accepts progress above the target — there is deliberately no such CHECK', async () => {
      const goal = await prisma.savingsGoal.create({
        data: {
          userId: fx.userId,
          name: 'Over-saved',
          targetAmount: new Prisma.Decimal('100'),
          currentProgress: new Prisma.Decimal('500'),
          currency: 'VND',
        },
      })

      expect(goal.currentProgress.toString()).toBe('500')
    })
  })

  describe('tracking only — no money moves', () => {
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
      // 5,000,000 initial minus the fixture's 250,000 expense — a real,
      // non-trivial figure, so "unchanged" is a meaningful assertion.
      expect(before.balance).toBe('4750000')

      // Every mutation the service has, on a goal whose target is met and then
      // exceeded: the exact sequence a user would produce, ending in an
      // archive.
      const goal = await createSavingsGoal(fx.userId, {
        ...BASE_INPUT,
        targetAmount: 1_000_000,
        currentProgress: 250_000,
        deadline: '2026-12-31',
        note: 'Tracking only',
      })
      await updateSavingsGoal(fx.userId, goal.id, {
        ...BASE_INPUT,
        targetAmount: 900_000,
        currency: 'USD',
        deadline: '2027-01-01',
        note: 'Edited',
      })
      await updateSavingsGoalProgress(fx.userId, goal.id, { currentProgress: 900_000 })
      await updateSavingsGoalProgress(fx.userId, goal.id, { currentProgress: 1_500_000 })
      await archiveSavingsGoal(fx.userId, goal.id)
      await listSavingsGoals(fx.userId)
      await listAllSavingsGoals(fx.userId)

      expect(await prisma.financialAccount.count({ where: { userId: fx.userId } })).toBe(
        before.accounts,
      )
      expect(await prisma.transaction.count({ where: { userId: fx.userId } })).toBe(
        before.transactions,
      )
      expect(await prisma.transfer.count({ where: { userId: fx.userId } })).toBe(before.transfers)
      expect((await getAccountBalance(fx.userId, fx.accountId)).toString()).toBe(before.balance)
      // Not just the counts: the rows themselves, field for field. A goal that
      // quietly rewrote an account's currency or an expense's amount would keep
      // every count identical.
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
     * The structural half of "no money moves": the service cannot touch the
     * ledger because it does not import anything that writes to it.
     *
     * Reading the source is deliberate rather than fragile. The behavioural case
     * above can only catch a write it happens to provoke, whereas a later phase
     * adding "mark achieved and move the money" would reintroduce exactly the
     * coupling spec §4.8 exists to avoid — and importing the module is the first
     * step of doing so. The doc comment names these modules on purpose, to say
     * why they are absent, so only import specifiers are matched.
     */
    it('imports nothing that could move money or reach a live rate', () => {
      const source = readFileSync(
        fileURLToPath(new URL('./savings-goal.ts', import.meta.url)),
        'utf8',
      )

      for (const forbidden of [
        'services/transaction',
        'services/transfer',
        'services/balance',
        'services/financial-account',
        'current-rate-policy',
        'fx-service',
        'current-amount',
        'historical-amount',
      ]) {
        expect(source).not.toMatch(new RegExp(`from '[^']*${forbidden}`))
      }
    })
  })
})
