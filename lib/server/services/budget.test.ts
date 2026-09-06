import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import type { Currency, TransactionType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  classifyBudgetStatus,
  createBudget,
  deleteBudget,
  getBudgetProgressForMonth,
  listAllBudgets,
  listBudgetsForMonth,
  updateBudget,
  DuplicateBudgetError,
  InvalidBudgetCategoryError,
} from './budget'

/**
 * Phase 5's data-layer acceptance check (spec §4.6, §5.5).
 *
 * Four properties are what this suite exists to hold:
 *
 * 1. **Uniqueness is the database's, not the service's.** Several cases bypass
 *    the service entirely and call Prisma directly, to prove the two partial
 *    unique indexes and the composite `(userId, categoryId)` foreign key hold
 *    even if application code regressed.
 * 2. **Progress is historical and EXPENSE-only.** Rows are inserted with their
 *    own `vndPerUsdAtEntry` — values no live rate would produce — and the
 *    service is checked to import nothing that could fetch one. `fetch` is a
 *    throwing spy for every test and `afterEach` asserts it was never called, so
 *    a stray FX lookup fails the suite rather than passing quietly. Nothing here
 *    reads or writes the global `ExchangeRate` table; see the "imports nothing
 *    that could reach a live rate" case for why.
 * 3. **The month is the user's.** The boundary cases use 17:00Z / 17:30Z, the
 *    instants that fall either side of local midnight in `Asia/Ho_Chi_Minh`.
 * 4. **Every read is tenant-scoped.** A second user with their own March budget
 *    and March spending is present in the progress cases, so dropping `userId`
 *    from any list or progress query fails a test.
 *
 * Rows are inserted directly rather than through `createTransaction`: these
 * cases are about what the budget aggregate computes, and going through the
 * transaction service would add an interactive transaction, a row lock and an
 * FX lookup per row without changing a single number — and would make the
 * snapshot rate whatever the provider said rather than the exact value each
 * assertion depends on.
 */

/** UTC+7, no DST, so every wall-clock assertion below is exact. */
const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

/** The `fxRateSource` this suite stamps on the transactions it seeds. It never
 *  reaches the global `ExchangeRate` table — nothing here writes that table. */
const FX_TEST_SOURCE = 'budget-test'

/** March 2026 in `TEST_TIMEZONE` is [2026-02-28T17:00Z, 2026-03-31T17:00Z). */
const MARCH = { year: 2026, month: 3 } as const
/** Comfortably inside March, local and UTC alike. */
const MID_MARCH = new Date('2026-03-15T05:00:00.000Z')

/**
 * The UTC start of the day containing `date` — an FX snapshot's effective day.
 * Deliberately local to this suite rather than imported from the export
 * fixtures: that module pulls in ExcelJS and every sheet builder, none of which
 * a budget test has any business loading.
 */
function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

interface BudgetFixture {
  userId: string
  accountTypeId: string
  vndAccountId: string
  usdAccountId: string
  foodCategoryId: string
  transportCategoryId: string
  incomeCategoryId: string
}

async function createBudgetUser(): Promise<BudgetFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `budget-${randomUUID()}@example.com`,
      name: 'Budget Test',
      emailVerified: false,
      timezone: TEST_TIMEZONE,
    },
  })
  const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
  const vndAccount = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Wallet',
      accountTypeId: accountType.id,
      initialBalance: 0,
      currency: 'VND',
    },
  })
  const usdAccount = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'Dollar savings',
      accountTypeId: accountType.id,
      initialBalance: 0,
      currency: 'USD',
    },
  })
  const food = await prisma.category.create({
    data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
  })
  const transport = await prisma.category.create({
    data: { userId: user.id, name: 'Transport', type: 'EXPENSE' },
  })
  const salary = await prisma.category.create({
    data: { userId: user.id, name: 'Salary', type: 'INCOME' },
  })
  return {
    userId: user.id,
    accountTypeId: accountType.id,
    vndAccountId: vndAccount.id,
    usdAccountId: usdAccount.id,
    foodCategoryId: food.id,
    transportCategoryId: transport.id,
    incomeCategoryId: salary.id,
  }
}

interface SeedTransaction {
  accountId: string
  categoryId?: string | null
  /** The generated enum types, not hand-copied unions: if `TransactionType` or
   *  `Currency` ever gains a member, this fixture keeps up on its own. */
  type?: TransactionType
  amount: number | string
  currency?: Currency
  date?: Date
  /** The row's OWN snapshot rate — settable per row, so a case can prove the
   *  aggregate uses it rather than whatever today's rate happens to be. */
  vndPerUsdAtEntry?: number | string
}

async function seedTransaction(userId: string, row: SeedTransaction) {
  const date = row.date ?? MID_MARCH
  return prisma.transaction.create({
    data: {
      userId,
      accountId: row.accountId,
      categoryId: row.categoryId ?? null,
      type: row.type ?? 'EXPENSE',
      amount: new Prisma.Decimal(row.amount),
      currency: row.currency ?? 'VND',
      date,
      vndPerUsdAtEntry: new Prisma.Decimal(row.vndPerUsdAtEntry ?? 25000),
      fxRateFetchedAt: date,
      fxRateEffectiveAt: utcDayStart(date),
      fxRateSource: FX_TEST_SOURCE,
    },
  })
}

/** Deletes a user's rows in FK order, then the user. Budgets go before
 *  categories: a CATEGORY budget holds a RESTRICT foreign key on one. */
async function cleanupUsers(userIds: string[]) {
  if (userIds.length === 0) return
  try {
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.budget.deleteMany({ where: { userId: { in: userIds } } })
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

describe('classifyBudgetStatus', () => {
  const amount = new Prisma.Decimal('1000000')

  it('names the five bands', () => {
    expect(classifyBudgetStatus(new Prisma.Decimal(0), amount)).toBe('ok')
    expect(classifyBudgetStatus(new Prisma.Decimal('499999.99'), amount)).toBe('ok')
    expect(classifyBudgetStatus(new Prisma.Decimal('500000'), amount)).toBe('warning_50')
    expect(classifyBudgetStatus(new Prisma.Decimal('799999.99'), amount)).toBe('warning_50')
    expect(classifyBudgetStatus(new Prisma.Decimal('800000'), amount)).toBe('warning_80')
    expect(classifyBudgetStatus(new Prisma.Decimal('999999.99'), amount)).toBe('warning_80')
    expect(classifyBudgetStatus(new Prisma.Decimal('1000000'), amount)).toBe('at_100')
    expect(classifyBudgetStatus(new Prisma.Decimal('1000000.01'), amount)).toBe('exceeded')
  })

  it('treats a stored scale as the same number (1000000.00 is exactly on target)', () => {
    expect(classifyBudgetStatus(new Prisma.Decimal('1000000.00'), amount)).toBe('at_100')
    expect(classifyBudgetStatus(amount, new Prisma.Decimal('1000000.00'))).toBe('at_100')
  })

  it('agrees with itself whether the ratio is supplied or computed', () => {
    // `getBudgetProgressForMonth` passes the ratio it already divided, so the
    // status and the number the UI renders can never diverge.
    for (const spent of ['0', '499999.99', '500000', '799999', '800000', '999999']) {
      const value = new Prisma.Decimal(spent)
      expect(classifyBudgetStatus(value, amount, value.div(amount))).toBe(
        classifyBudgetStatus(value, amount),
      )
    }
  })

  it('refuses a non-positive amount rather than dividing by zero', () => {
    expect(() => classifyBudgetStatus(new Prisma.Decimal(1), new Prisma.Decimal(0))).toThrow(
      /must be positive/,
    )
    expect(() => classifyBudgetStatus(new Prisma.Decimal(1), new Prisma.Decimal(-5))).toThrow(
      /must be positive/,
    )
  })
})

describe('budget service', () => {
  let fetchSpy: MockInstance
  let fx: BudgetFixture
  /** Extra users a single case created; cleaned up with the fixture. */
  let extraUserIds: string[]

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    extraUserIds = []
    fx = await createBudgetUser()
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    // Only this suite's own users are cleaned up. `ExchangeRate` is deliberately
    // absent from the cleanup because it is deliberately absent from the suite:
    // see "imports nothing that could reach a live rate" below.
    await cleanupUsers([fx.userId, ...extraUserIds])
    // No budget code path may reach the network: progress is computed from each
    // row's own snapshot, never from a live rate.
    expect(fetchCalls).toBe(0)
  })

  describe('model', () => {
    it('creates an OVERALL budget with no category', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      expect(budget.scope).toBe('OVERALL')
      expect(budget.categoryId).toBeNull()
      expect(budget.category).toBeNull()
      expect(budget.amount.toString()).toBe('5000000')
      expect(budget.currency).toBe('VND')
      expect(budget.year).toBe(2026)
      expect(budget.month).toBe(3)
    })

    it('ignores a categoryId supplied for an OVERALL budget', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        categoryId: fx.foodCategoryId,
        amount: 5_000_000,
        currency: 'VND',
      })

      expect(budget.categoryId).toBeNull()
    })

    it('creates a CATEGORY budget and returns the category include', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })

      expect(budget.scope).toBe('CATEGORY')
      expect(budget.categoryId).toBe(fx.foodCategoryId)
      expect(budget.category).toEqual({
        id: fx.foodCategoryId,
        name: 'Food',
        type: 'EXPENSE',
        status: 'ACTIVE',
      })
    })

    it('updates the amount and currency', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      const updated = await updateBudget(fx.userId, budget.id, { amount: 250.5, currency: 'USD' })

      expect(updated.amount.toString()).toBe('250.5')
      expect(updated.currency).toBe('USD')
      // Identity is immutable: the month and scope are untouched by an edit.
      expect(updated.year).toBe(2026)
      expect(updated.month).toBe(3)
      expect(updated.scope).toBe('OVERALL')
    })

    it('deletes a budget, after which the month lists none', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      await deleteBudget(fx.userId, budget.id)

      expect(await listBudgetsForMonth(fx.userId, MARCH.year, MARCH.month)).toEqual([])
    })

    it('rejects a second OVERALL budget in the same month with DuplicateBudgetError', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      await expect(
        createBudget(fx.userId, {
          ...MARCH,
          scope: 'OVERALL',
          amount: 9_000_000,
          currency: 'VND',
        }),
      ).rejects.toThrow(DuplicateBudgetError)

      expect(await prisma.budget.count({ where: { userId: fx.userId } })).toBe(1)
    })

    it('rejects a second budget for the same category and month with DuplicateBudgetError', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })

      await expect(
        createBudget(fx.userId, {
          ...MARCH,
          scope: 'CATEGORY',
          categoryId: fx.foodCategoryId,
          amount: 2_000_000,
          currency: 'VND',
        }),
      ).rejects.toThrow(DuplicateBudgetError)

      expect(await prisma.budget.count({ where: { userId: fx.userId } })).toBe(1)
    })

    it('allows the same category in a different month', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        year: 2026,
        month: 4,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_500_000,
        currency: 'VND',
      })

      expect(await prisma.budget.count({ where: { userId: fx.userId } })).toBe(2)
    })

    it('allows two different categories in the same month', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.transportCategoryId,
        amount: 500_000,
        currency: 'VND',
      })

      expect(await prisma.budget.count({ where: { userId: fx.userId } })).toBe(2)
    })

    it('allows an OVERALL and a CATEGORY budget in the same month', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })

      const budgets = await listBudgetsForMonth(fx.userId, MARCH.year, MARCH.month)
      // OVERALL first, then category budgets by name.
      expect(budgets.map((b) => b.scope)).toEqual(['OVERALL', 'CATEGORY'])
    })

    it("rejects another user's categoryId and writes nothing for either user", async () => {
      const other = await createBudgetUser()
      extraUserIds.push(other.userId)

      await expect(
        createBudget(fx.userId, {
          ...MARCH,
          scope: 'CATEGORY',
          categoryId: other.foodCategoryId,
          amount: 1_000_000,
          currency: 'VND',
        }),
      ).rejects.toThrow(InvalidBudgetCategoryError)

      expect(await prisma.budget.count({ where: { userId: fx.userId } })).toBe(0)
      expect(await prisma.budget.count({ where: { userId: other.userId } })).toBe(0)
    })

    it('rejects an INCOME category', async () => {
      await expect(
        createBudget(fx.userId, {
          ...MARCH,
          scope: 'CATEGORY',
          categoryId: fx.incomeCategoryId,
          amount: 1_000_000,
          currency: 'VND',
        }),
      ).rejects.toThrow(InvalidBudgetCategoryError)

      expect(await prisma.budget.count({ where: { userId: fx.userId } })).toBe(0)
    })

    it('rejects an archived EXPENSE category for a new budget', async () => {
      await prisma.category.update({
        where: { userId_id: { userId: fx.userId, id: fx.foodCategoryId } },
        data: { status: 'ARCHIVED' },
      })

      await expect(
        createBudget(fx.userId, {
          ...MARCH,
          scope: 'CATEGORY',
          categoryId: fx.foodCategoryId,
          amount: 1_000_000,
          currency: 'VND',
        }),
      ).rejects.toThrow(InvalidBudgetCategoryError)
    })

    it("rejects a Budget referencing another user's category even bypassing the service (P2003)", async () => {
      const other = await createBudgetUser()
      extraUserIds.push(other.userId)

      await expectPrismaCode(
        prisma.budget.create({
          data: {
            userId: fx.userId,
            ...MARCH,
            scope: 'CATEGORY',
            categoryId: other.foodCategoryId,
            amount: new Prisma.Decimal(1_000_000),
            currency: 'VND',
          },
        }),
        'P2003',
      )
    })

    it('rejects a second OVERALL row at the database level (P2002 on the partial index)', async () => {
      await prisma.budget.create({
        data: {
          userId: fx.userId,
          ...MARCH,
          scope: 'OVERALL',
          amount: new Prisma.Decimal(5_000_000),
          currency: 'VND',
        },
      })

      await expectPrismaCode(
        prisma.budget.create({
          data: {
            userId: fx.userId,
            ...MARCH,
            scope: 'OVERALL',
            amount: new Prisma.Decimal(9_000_000),
            currency: 'VND',
          },
        }),
        'P2002',
      )
    })

    it("rejects updating another user's budget with P2025 and leaves the row untouched", async () => {
      const other = await createBudgetUser()
      extraUserIds.push(other.userId)
      const theirs = await createBudget(other.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      await expectPrismaCode(
        updateBudget(fx.userId, theirs.id, { amount: 1, currency: 'USD' }),
        'P2025',
      )

      const stored = await prisma.budget.findUniqueOrThrow({
        where: { userId_id: { userId: other.userId, id: theirs.id } },
      })
      expect(stored.amount.toString()).toBe('5000000')
      expect(stored.currency).toBe('VND')
    })

    it("rejects deleting another user's budget with P2025 and the row still exists", async () => {
      const other = await createBudgetUser()
      extraUserIds.push(other.userId)
      const theirs = await createBudget(other.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      await expectPrismaCode(deleteBudget(fx.userId, theirs.id), 'P2025')

      expect(await prisma.budget.count({ where: { userId: other.userId, id: theirs.id } })).toBe(1)
    })

    it('lists every budget newest month first for the export sheet', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.transportCategoryId,
        amount: 400_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        year: 2026,
        month: 4,
        scope: 'OVERALL',
        amount: 6_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        year: 2025,
        month: 12,
        scope: 'OVERALL',
        amount: 4_000_000,
        currency: 'VND',
      })

      const all = await listAllBudgets(fx.userId)

      expect(all.map((b) => `${b.year}-${b.month}:${b.scope}:${b.category?.name ?? '-'}`)).toEqual([
        '2026-4:OVERALL:-',
        '2026-3:OVERALL:-',
        '2026-3:CATEGORY:Food',
        '2026-3:CATEGORY:Transport',
        '2025-12:OVERALL:-',
      ])
    })
  })

  describe('progress', () => {
    /**
     * The tenant filter on the *read* paths, which the mutation cases above
     * cannot reach: `createBudget` / `updateBudget` / `deleteBudget` fail loudly
     * on another user's id, but a list or a progress scan missing its `userId`
     * fails silently — it just returns too much. So a second user is given the
     * same month, the same category name and their own spending, and every read
     * is asserted to see none of it. Delete `userId` from the `where` in
     * `listBudgetsForMonth`, `listAllBudgets` or the transaction scan in
     * `getBudgetProgressForMonth` and this case fails.
     */
    it("never sees another user's budgets or spending", async () => {
      const other = await createBudgetUser()
      extraUserIds.push(other.userId)

      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.foodCategoryId,
        amount: 400_000,
      })

      // The other user's month is identical in every respect except ownership:
      // same year and month, a category with the same name, and both an OVERALL
      // and a CATEGORY budget so neither scope's scan can leak.
      const theirOverall = await createBudget(other.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 9_000_000,
        currency: 'VND',
      })
      const theirCategory = await createBudget(other.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: other.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })
      await seedTransaction(other.userId, {
        accountId: other.vndAccountId,
        categoryId: other.foodCategoryId,
        amount: 777_000,
      })
      await seedTransaction(other.userId, {
        accountId: other.vndAccountId,
        categoryId: other.transportCategoryId,
        amount: 888_000,
      })

      const progress = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)
      expect(progress).toHaveLength(1)
      // 400000, not 1177000: the other user's Food spending is invisible even
      // though it is the same month and the same category name.
      expect(progress[0].spent.toString()).toBe('400000')
      expect(progress[0].budget.userId).toBe(fx.userId)

      const month = await listBudgetsForMonth(fx.userId, MARCH.year, MARCH.month)
      const all = await listAllBudgets(fx.userId)
      for (const list of [month, all]) {
        expect(list.map((b) => b.userId)).toEqual([fx.userId])
        expect(list.map((b) => b.id)).not.toContain(theirOverall.id)
        expect(list.map((b) => b.id)).not.toContain(theirCategory.id)
      }

      // And symmetrically: the other user's own read is unaffected by ours.
      const theirProgress = await getBudgetProgressForMonth(other.userId, TEST_TIMEZONE, 2026, 3)
      expect(theirProgress.map((p) => p.spent.toString())).toEqual(['1665000', '777000'])
    })

    it('counts only EXPENSE transactions — never income, cash movements, adjustments or transfers', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.foodCategoryId,
        type: 'EXPENSE',
        amount: 500_000,
      })
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.incomeCategoryId,
        type: 'INCOME',
        amount: 9_000_000,
      })
      for (const type of [
        'CASH_IN',
        'CASH_OUT',
        'ADJUSTMENT_INCREASE',
        'ADJUSTMENT_DECREASE',
      ] as const) {
        await seedTransaction(fx.userId, { accountId: fx.vndAccountId, type, amount: 1_000_000 })
      }
      await prisma.transfer.create({
        data: {
          userId: fx.userId,
          fromAccountId: fx.vndAccountId,
          toAccountId: fx.usdAccountId,
          fromAmount: new Prisma.Decimal(2_500_000),
          toAmount: new Prisma.Decimal(100),
          exchangeRateUsed: new Prisma.Decimal(25000),
          date: MID_MARCH,
        },
      })

      const [progress] = await getBudgetProgressForMonth(
        fx.userId,
        TEST_TIMEZONE,
        MARCH.year,
        MARCH.month,
      )

      expect(progress.budget.id).toBe(budget.id)
      expect(progress.spent.toString()).toBe('500000')
      expect(progress.remaining.toString()).toBe('4500000')
      expect(progress.ratio.toString()).toBe('0.1')
      expect(progress.status).toBe('ok')
    })

    it('scopes a CATEGORY budget to its own category, excluding other and uncategorised expenses', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })

      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.foodCategoryId,
        amount: 300_000,
      })
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.transportCategoryId,
        amount: 700_000,
      })
      // An uncategorised expense: it belongs to the month but to no category.
      await seedTransaction(fx.userId, { accountId: fx.vndAccountId, amount: 900_000 })

      const [progress] = await getBudgetProgressForMonth(
        fx.userId,
        TEST_TIMEZONE,
        MARCH.year,
        MARCH.month,
      )

      expect(progress.spent.toString()).toBe('300000')
      expect(progress.status).toBe('ok')
    })

    it('counts every expense including uncategorised ones for an OVERALL budget', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.foodCategoryId,
        amount: 300_000,
      })
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.transportCategoryId,
        amount: 700_000,
      })
      await seedTransaction(fx.userId, { accountId: fx.vndAccountId, amount: 900_000 })

      const [progress] = await getBudgetProgressForMonth(
        fx.userId,
        TEST_TIMEZONE,
        MARCH.year,
        MARCH.month,
      )

      expect(progress.spent.toString()).toBe('1900000')
    })

    it("assigns a transaction to the month it falls in in the user's timezone", async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })
      await createBudget(fx.userId, {
        year: 2026,
        month: 4,
        scope: 'OVERALL',
        amount: 5_000_000,
        currency: 'VND',
      })

      // 2026-03-01 00:00 local — the first instant of March in +07.
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        amount: 111_000,
        date: new Date('2026-02-28T17:00:00.000Z'),
      })
      // 2026-04-01 00:30 local — April, though still 31 March in UTC.
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        amount: 222_000,
        date: new Date('2026-03-31T17:30:00.000Z'),
      })

      const [march] = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)
      const [april] = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 4)

      expect(march.spent.toString()).toBe('111000')
      expect(april.spent.toString()).toBe('222000')
    })

    it("converts a USD expense at the row's own snapshot rate, not today's", async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 10_000_000,
        currency: 'VND',
      })
      await seedTransaction(fx.userId, {
        accountId: fx.usdAccountId,
        currency: 'USD',
        amount: 100,
        vndPerUsdAtEntry: 25500,
      })

      // 25500 is the row's own snapshot, and no live rate produced it: this
      // suite never lets a provider run, so 2550000 can only have come from the
      // stored value.
      const progress = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)
      expect(progress[0].spent.toString()).toBe('2550000')
      // Repeating the call is the "today's rate cannot move it" half: the answer
      // is a pure function of the stored rows, so it is stable by construction.
      const again = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)
      expect(again[0].spent.toString()).toBe('2550000')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    /**
     * The structural half of "changing today's FX cannot alter progress", and
     * the reason no case here writes to `ExchangeRate`.
     *
     * `ExchangeRate` is the one global, non-tenant table
     * (`(base, quote, effectiveDate)` is its natural key), and today's USD/VND
     * row is owned by `lib/currency/current-rate-policy.test.ts`, which seeds it
     * and asserts on its exact rate and source. Vitest runs test *files* in
     * parallel, so writing or deleting that row from here would make a sibling
     * suite fail non-deterministically — this suite would be proving its own
     * invariant by breaking someone else's.
     *
     * So the invariant is proved where it actually lives: the service cannot
     * consult a live rate because it does not import anything that can produce
     * one. Reading the source is deliberate rather than fragile — an import
     * added in a later phase (a "show the target in today's money" feature, say)
     * would silently reintroduce exactly the drift `historicalAmountIn` exists
     * to prevent, and nothing else in the suite would notice.
     */
    it('imports nothing that could reach a live rate', () => {
      const source = readFileSync(fileURLToPath(new URL('./budget.ts', import.meta.url)), 'utf8')

      for (const forbidden of [
        'current-rate-policy',
        'fx-service',
        'current-amount',
        'currency/provider',
        '@prisma/client/runtime',
      ]) {
        // Import specifiers only: the doc comment names these modules on
        // purpose, to say why they are absent.
        expect(source).not.toMatch(new RegExp(`from '[^']*${forbidden}`))
      }
      // And the conversion it does use is the historical one.
      expect(source).toContain("from '@/lib/currency/historical-amount'")
    })

    it('aggregates mixed VND and USD expenses into a VND budget', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 10_000_000,
        currency: 'VND',
      })
      await seedTransaction(fx.userId, { accountId: fx.vndAccountId, amount: 1_000_000 })
      await seedTransaction(fx.userId, {
        accountId: fx.usdAccountId,
        currency: 'USD',
        amount: 100,
        vndPerUsdAtEntry: 24000,
      })

      const [progress] = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)

      expect(progress.spent.toString()).toBe('3400000')
      expect(progress.remaining.toString()).toBe('6600000')
      expect(progress.ratio.toString()).toBe('0.34')
    })

    it('aggregates a VND expense into a USD budget with no rounding', async () => {
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 100,
        currency: 'USD',
      })
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        amount: 250_000,
        vndPerUsdAtEntry: 25000,
      })

      const [progress] = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)

      expect(progress.spent.toString()).toBe('10')
      expect(progress.remaining.toString()).toBe('90')
      expect(progress.ratio.toString()).toBe('0.1')
    })

    it.each([
      { spent: 0, status: 'ok', remaining: '1000000', ratio: '0' },
      { spent: 499_999.99, status: 'ok', remaining: '500000.01', ratio: '0.49999999' },
      { spent: 500_000, status: 'warning_50', remaining: '500000', ratio: '0.5' },
      { spent: 799_999, status: 'warning_50', remaining: '200001', ratio: '0.799999' },
      { spent: 800_000, status: 'warning_80', remaining: '200000', ratio: '0.8' },
      { spent: 999_999, status: 'warning_80', remaining: '1', ratio: '0.999999' },
      { spent: 1_000_000, status: 'at_100', remaining: '0', ratio: '1' },
      { spent: 1_000_000.01, status: 'exceeded', remaining: '-0.01', ratio: '1.00000001' },
    ])(
      'reports $status when $spent of a 1,000,000 VND budget is spent',
      async ({ spent, status, remaining, ratio }) => {
        await createBudget(fx.userId, {
          ...MARCH,
          scope: 'OVERALL',
          amount: 1_000_000,
          currency: 'VND',
        })
        if (spent > 0) {
          await seedTransaction(fx.userId, { accountId: fx.vndAccountId, amount: spent })
        }

        const [progress] = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)

        expect(progress.spent.toString()).toBe(String(spent))
        expect(progress.remaining.toString()).toBe(remaining)
        expect(progress.ratio.toString()).toBe(ratio)
        expect(progress.status).toBe(status)
      },
    )

    it('returns no progress and does not scan transactions when the month has no budgets', async () => {
      const findMany = vi.spyOn(prisma.transaction, 'findMany')

      expect(await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)).toEqual([])
      expect(findMany).not.toHaveBeenCalled()
    })

    it('rejects an out-of-range month whether or not the user has budgets', async () => {
      // Validated before the empty-month early return, so a bad request from
      // Task 3's URL param fails the same way for every user.
      await expect(getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 13)).rejects.toThrow(
        RangeError,
      )

      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 1_000_000,
        currency: 'VND',
      })
      await expect(getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 13)).rejects.toThrow(
        RangeError,
      )
    })

    it('scans the transaction table exactly once, whatever the number of budgets', async () => {
      // Five budgets in one month: one OVERALL plus four categories. A
      // per-budget query would be five scans; the service does one.
      const bills = await prisma.category.create({
        data: { userId: fx.userId, name: 'Bills', type: 'EXPENSE' },
      })
      const health = await prisma.category.create({
        data: { userId: fx.userId, name: 'Health', type: 'EXPENSE' },
      })
      await createBudget(fx.userId, {
        ...MARCH,
        scope: 'OVERALL',
        amount: 9_000_000,
        currency: 'VND',
      })
      for (const categoryId of [fx.foodCategoryId, fx.transportCategoryId, bills.id, health.id]) {
        await createBudget(fx.userId, {
          ...MARCH,
          scope: 'CATEGORY',
          categoryId,
          amount: 1_000_000,
          currency: 'VND',
        })
      }
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.foodCategoryId,
        amount: 400_000,
      })

      const findMany = vi.spyOn(prisma.transaction, 'findMany')
      const progress = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)

      expect(findMany).toHaveBeenCalledTimes(1)
      // OVERALL first, then Bills, Food, Health, Transport by name. The OVERALL
      // budget and Food both see the expense; the other three see nothing.
      expect(
        progress.map((p) => `${p.budget.category?.name ?? 'OVERALL'}=${p.spent.toString()}`),
      ).toEqual(['OVERALL=400000', 'Bills=0', 'Food=400000', 'Health=0', 'Transport=0'])
    })
  })

  describe('history', () => {
    it('keeps a budget readable and its progress correct after its category is archived', async () => {
      const budget = await createBudget(fx.userId, {
        ...MARCH,
        scope: 'CATEGORY',
        categoryId: fx.foodCategoryId,
        amount: 1_000_000,
        currency: 'VND',
      })
      await seedTransaction(fx.userId, {
        accountId: fx.vndAccountId,
        categoryId: fx.foodCategoryId,
        amount: 600_000,
      })

      await prisma.category.update({
        where: { userId_id: { userId: fx.userId, id: fx.foodCategoryId } },
        data: { status: 'ARCHIVED' },
      })

      const budgets = await listBudgetsForMonth(fx.userId, MARCH.year, MARCH.month)
      expect(budgets).toHaveLength(1)
      expect(budgets[0].id).toBe(budget.id)
      expect(budgets[0].category?.status).toBe('ARCHIVED')

      const [progress] = await getBudgetProgressForMonth(fx.userId, TEST_TIMEZONE, 2026, 3)
      expect(progress.spent.toString()).toBe('600000')
      expect(progress.status).toBe('warning_50')
    })
  })
})
