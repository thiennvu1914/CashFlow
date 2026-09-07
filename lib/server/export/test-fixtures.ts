import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { loadExportProfile, resolveExportFx } from './export-context'
import type { ExportContext } from './sheet-registry'

/**
 * Fixtures shared by the two export test suites.
 *
 * Not a `.test.ts` file, so Vitest never collects it as a suite of its own; it
 * is imported only by `filtered-export.test.ts` and `full-export.test.ts`,
 * which build the same shape of ledger and would otherwise duplicate every
 * `prisma.create` between them.
 *
 * Rows are inserted directly rather than through the services: these suites are
 * about what the workbook contains, and going through `createTransaction` would
 * add an interactive transaction, a row lock and an FX lookup per row without
 * changing a single cell.
 */

/** The `source` strings these suites can leave in the shared FX cache. */
export const EXPORT_TEST_FX_SOURCES = ['export-fake', 'export-seeded']

/** Every test user is in this zone — UTC+7, no DST, so the wall-clock
 *  arithmetic in the assertions is exact. */
export const TEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

/**
 * A provider that always answers, so `resolveExportFx` yields a real
 * `UsableRateResult` without touching the network.
 *
 * It is consulted exactly once per export, when the context is assembled. Every
 * sheet is then handed that resolved rate, so nothing downstream reaches for a
 * provider — or a cache row — of its own, and a suite can assert an exact rate
 * without depending on what the shared `ExchangeRate` table happens to hold.
 */
export function fakeFxProvider(rate = 26000): ExchangeRateProvider {
  const fetchedAt = new Date(Date.now() - 5 * 60 * 1000)
  return {
    getLatestRate: async () => ({
      rate,
      effectiveDate: new Date(),
      fetchedAt,
      source: 'export-fake',
    }),
    getHistoricalRate: async () => null,
  }
}

/** Stands in for a total FX outage — the only way to the "unavailable" cells. */
export const failingFxProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

export interface MakeExportContextOptions {
  /** The instant the export was requested. */
  now?: Date
  /**
   * Whether to resolve a current rate at all. `false` mirrors the filtered
   * export, which is historical end to end and reads `ctx.fx` nowhere.
   */
  withFx?: boolean
  providerOverride?: ExchangeRateProvider
}

/**
 * An `ExportContext` for a suite that wants to build a workbook — the route's
 * own two steps, `loadExportProfile` then (optionally) `resolveExportFx`, in
 * that order.
 *
 * A **test** helper on purpose. Production deliberately has no such function:
 * the route interleaves range validation between the two steps, so a malformed
 * URL costs no provider round trip and the filtered export costs none at all. A
 * shared "give me the whole context" convenience would invite a caller to fetch
 * a rate before knowing whether the request is even valid, which is exactly the
 * ordering the route exists to get right.
 */
export async function makeExportContext(
  userId: string,
  options: MakeExportContextOptions = {},
): Promise<ExportContext> {
  const { now = new Date(), withFx = true, providerOverride } = options
  const profile = await loadExportProfile(userId)
  return { ...profile, fx: withFx ? await resolveExportFx(providerOverride) : null, now }
}

export interface ExportFixture {
  userId: string
  accountTypeId: string
  vndAccountId: string
  usdAccountId: string
  expenseCategoryId: string
  incomeCategoryId: string
}

export async function createExportUser(
  baseCurrency: 'VND' | 'USD' = 'VND',
): Promise<ExportFixture> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `export-${randomUUID()}@example.com`,
      name: 'Export Test',
      emailVerified: false,
      baseCurrency,
      timezone: TEST_TIMEZONE,
    },
  })
  const accountType = await prisma.accountType.create({
    data: { userId: user.id, name: 'Cash' },
  })
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
  const expenseCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
  })
  const incomeCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Salary', type: 'INCOME' },
  })
  return {
    userId: user.id,
    accountTypeId: accountType.id,
    vndAccountId: vndAccount.id,
    usdAccountId: usdAccount.id,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }
}

/** The UTC start of the day containing `date` — an FX snapshot's effective day. */
export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export interface SeedTransaction {
  accountId: string
  categoryId?: string | null
  type?: 'INCOME' | 'EXPENSE' | 'CASH_IN' | 'CASH_OUT'
  amount: number | string
  currency?: 'VND' | 'USD'
  date: Date
  note?: string
  /** The row's OWN snapshot rate — deliberately settable per row, so a test can
   *  prove a converted column uses it rather than today's rate. */
  vndPerUsdAtEntry?: number
}

export async function seedTransaction(userId: string, row: SeedTransaction) {
  const date = row.date
  return prisma.transaction.create({
    data: {
      userId,
      accountId: row.accountId,
      categoryId: row.categoryId ?? null,
      type: row.type ?? 'EXPENSE',
      amount: new Prisma.Decimal(row.amount),
      currency: row.currency ?? 'VND',
      date,
      note: row.note ?? null,
      vndPerUsdAtEntry: new Prisma.Decimal(row.vndPerUsdAtEntry ?? 25000),
      fxRateFetchedAt: date,
      fxRateEffectiveAt: utcDayStart(date),
      fxRateSource: 'export-seeded',
    },
  })
}

/** Removes every row these suites can create, FX cache rows included. */
export async function cleanupExportUsers(userIds: string[]) {
  await prisma.exchangeRate.deleteMany({ where: { source: { in: EXPORT_TEST_FX_SOURCES } } })
  // The provider fakes cache under today's USD/VND key; clear the pair outright
  // so a neighbouring suite's row cannot make an "FX unavailable" test pass a
  // rate it was never given.
  await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  if (userIds.length === 0) return
  try {
    // Children before their parent row throughout: every one of these foreign
    // keys is ON DELETE RESTRICT, so the other order is a P2003 rather than a
    // cascade.
    //
    // Occurrences and reminders come first of all, ahead of the transactions,
    // because a reminder also references a Category and a FinancialAccount —
    // both deleted further down — so a reminder still standing would block
    // those deletions rather than its own.
    await prisma.reminderOccurrence.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.recurringReminder.deleteMany({ where: { userId: { in: userIds } } })
    // No children of its own, and referenced by nothing.
    await prisma.savingsGoal.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
    // Debts, loans and their payment histories reach these suites through the
    // Summary sheet's Net Worth figure and through the four Phase 6 sheets that
    // list them outright.
    await prisma.debtPayment.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.debt.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.loanPayment.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.loan.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    // Before the categories: a CATEGORY budget references one, so deleting the
    // category first is a foreign-key violation rather than a cascade.
    await prisma.budget.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}
