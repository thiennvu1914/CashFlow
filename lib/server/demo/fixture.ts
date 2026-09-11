/**
 * DEVELOPMENT DEMO DATA — SAFE TO DELETE — NEVER FOR PRODUCTION USE.
 *
 * The ledger `npm run demo:seed` builds, so the dashboard, the reports, the
 * planning pages and the Excel export can all be evaluated the moment the app
 * is opened (spec §13, §16).
 *
 * Two rules shape every line below.
 *
 * **Everything goes through the services.** Not one row here is a raw
 * `prisma.<model>.create`. That is not a style preference: `createTransaction`
 * is what snapshots the real FX rate on every row, `createTransfer` is what
 * derives a same-currency `toAmount` and records the effective rate on a
 * cross-currency one, `createBudget`/`createReminder` are what enforce the
 * category rules, and `recordDebtPayment`/`recordLoanPayment` are what hold
 * the overpayment and split invariants. A fixture that inserted rows directly
 * would be a fixture that can hold data the application itself would refuse —
 * exactly the data an evaluator would then report as a bug.
 *
 * **Dates are deterministic in one zone.** Everything is derived from "today"
 * in `DEMO_TIMEZONE` (UTC+7, no DST), so a run on any machine, in any process
 * timezone, produces the same calendar days. Current-month days are clamped to
 * today, so the fixture never contains a future-dated transaction.
 *
 * `providerOverride` exists for the tests only, exactly as it does on
 * `createTransaction` itself: the suite must not reach the network, and a
 * fixed provider keeps the FX snapshot assertable. Production callers (the two
 * scripts) omit it and get the real FX policy — cache, live provider, or a
 * recent last-known-good rate — and a genuine FX outage fails the seed rather
 * than inventing a rate.
 */

import {
  calendarDateToUtcCarrier,
  formatCalendarDate,
  todayCalendarDateInZone,
} from '@/lib/datetime/calendar-date'
import { addCalendarMonths, getCalendarMonth } from '@/lib/datetime/calendar-month'
import type { CalendarMonth } from '@/lib/datetime/calendar-month'
import { localDateTimeToInstant } from '@/lib/datetime/local-date-time'
import { getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { seedDefaultsForUser } from '@/lib/server/defaults'
import { createBudget } from '@/lib/server/services/budget'
import { createDebt, recordDebtPayment } from '@/lib/server/services/debt'
import { createFinancialAccount } from '@/lib/server/services/financial-account'
import { createLoan, recordLoanPayment } from '@/lib/server/services/loan'
import { createReminder, materializeDueOccurrences } from '@/lib/server/services/reminder'
import { createSavingsGoal } from '@/lib/server/services/savings-goal'
import { createTransaction } from '@/lib/server/services/transaction'
import { createTransfer } from '@/lib/server/services/transfer'
import { prisma } from '@/lib/prisma'
import { DEMO_TIMEZONE } from './constants'

/** One row per entity the fixture writes; printed by `demo:seed`. */
export interface DemoFixtureCounts {
  accountTypes: number
  categories: number
  accounts: number
  transactions: number
  transfers: number
  budgets: number
  savingsGoals: number
  debts: number
  debtPayments: number
  loans: number
  loanPayments: number
  reminders: number
  reminderOccurrences: number
}

export interface SeedDemoFixtureOptions {
  /** Tests only — see the module comment. Production callers omit it. */
  providerOverride?: ExchangeRateProvider
  /** Tests only: pins "today" so the built calendar is assertable. */
  now?: Date
}

/** The demo accounts, keyed so the transaction table below can name them. */
const ACCOUNTS = [
  { key: 'cash', name: 'Cash Wallet', type: 'Cash', currency: 'VND', initialBalance: 2_000_000 },
  {
    key: 'bank',
    name: 'Vietcombank Current',
    type: 'Bank Account',
    currency: 'VND',
    initialBalance: 20_000_000,
  },
  { key: 'ewallet', name: 'MoMo', type: 'E-wallet', currency: 'VND', initialBalance: 1_500_000 },
  {
    key: 'usd',
    name: 'USD Savings',
    type: 'Savings Account',
    currency: 'USD',
    initialBalance: 500,
  },
] as const

type AccountKey = (typeof ACCOUNTS)[number]['key']

/**
 * One month of activity, repeated for each of the three months.
 *
 * `day` is the day of the month the entry falls on; in the current month it is
 * clamped to today, so the newest month is partial in exactly the way a real
 * ledger is partway through a month.
 *
 * `category` is a default category name from `lib/server/defaults.ts`.
 * `CASH_OUT` carries none — the category requirement covers INCOME and EXPENSE
 * only, and one uncategorised row keeps that path represented.
 */
const MONTHLY_TRANSACTIONS: readonly {
  day: number
  type: 'INCOME' | 'EXPENSE' | 'CASH_OUT'
  account: AccountKey
  category?: string
  amount: number
  note?: string
}[] = [
  { day: 3, type: 'EXPENSE', account: 'cash', category: 'Food & Dining', amount: 850_000 },
  { day: 5, type: 'INCOME', account: 'bank', category: 'Salary', amount: 25_000_000 },
  { day: 6, type: 'EXPENSE', account: 'cash', category: 'Transportation', amount: 400_000 },
  { day: 8, type: 'EXPENSE', account: 'bank', category: 'Education', amount: 1_800_000 },
  { day: 9, type: 'EXPENSE', account: 'ewallet', category: 'Food & Dining', amount: 1_250_000 },
  { day: 12, type: 'EXPENSE', account: 'bank', category: 'Shopping', amount: 2_300_000 },
  // The USD leg: an expense in the foreign-currency account, so every screen
  // that converts a figure has something real to convert.
  { day: 14, type: 'EXPENSE', account: 'usd', category: 'Travel', amount: 45 },
  {
    day: 15,
    type: 'EXPENSE',
    account: 'bank',
    category: 'Bills & Utilities',
    amount: 1_200_000,
  },
  { day: 18, type: 'INCOME', account: 'bank', category: 'Freelance', amount: 4_500_000 },
  { day: 21, type: 'EXPENSE', account: 'ewallet', category: 'Entertainment', amount: 600_000 },
  { day: 24, type: 'EXPENSE', account: 'cash', category: 'Health', amount: 350_000 },
  { day: 27, type: 'EXPENSE', account: 'cash', category: 'Family', amount: 900_000 },
  {
    day: 28,
    type: 'CASH_OUT',
    account: 'cash',
    amount: 300_000,
    note: 'Cash withdrawn, not yet categorised',
  },
]

/** How many whole months of history the fixture lays down, today's included. */
const MONTHS_OF_HISTORY = 3

/** Days in a calendar month, read in UTC — a (year, month) pair has no zone. */
function daysInCalendarMonth(month: CalendarMonth): number {
  return new Date(Date.UTC(month.year, month.month, 0)).getUTCDate()
}

/** `yyyy-MM-dd` for a day of a calendar month. */
function calendarDate(month: CalendarMonth, day: number): string {
  return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** A calendar date shifted by whole days, via the UTC carrier (no zone). */
function shiftCalendarDate(date: string, days: number): string {
  const carrier = calendarDateToUtcCarrier(date)
  carrier.setUTCDate(carrier.getUTCDate() + days)
  return formatCalendarDate(carrier)
}

/**
 * A wall-clock instant for a demo entry: the given day in `DEMO_TIMEZONE` at a
 * plausible hour, converted to the UTC instant actually stored.
 *
 * The hour varies with the day so the day's rows have a stable order rather
 * than all landing on the same second.
 */
function instantFor(month: CalendarMonth, day: number, hour: number, now: Date): Date {
  const instant = localDateTimeToInstant(
    `${calendarDate(month, day)}T${String(hour).padStart(2, '0')}:30`,
    DEMO_TIMEZONE,
  )
  // Clamped to "now" rather than merely to today's DATE: a current-month entry
  // whose template hour is later than the wall-clock hour of the run would
  // otherwise be a future-dated transaction — which the app allows but a demo
  // ledger should never contain, because it makes "this month so far" read as
  // more than has actually happened.
  return instant.getTime() > now.getTime() ? now : instant
}

/**
 * Fills a demo user's ledger. Assumes the user exists and owns nothing yet —
 * `seedDemoUser` guarantees both by resetting first.
 */
export async function seedDemoFixture(
  userId: string,
  options: SeedDemoFixtureOptions = {},
): Promise<DemoFixtureCounts> {
  const now = options.now ?? new Date()
  const provider = options.providerOverride

  // The registration hook (`lib/auth/create-auth.ts`) already seeds these for
  // a brand-new user, but a RESEED runs against a user whose defaults were
  // just deleted. Calling it here covers both: it fills in missing names one
  // at a time and leaves anything already present alone, so it can never
  // double a taxonomy.
  await seedDefaultsForUser(userId)

  const accountTypes = await prisma.accountType.findMany({ where: { userId } })
  const categories = await prisma.category.findMany({ where: { userId } })
  const accountTypeByName = new Map(accountTypes.map((row) => [row.name, row.id]))
  const categoryByName = new Map(categories.map((row) => [`${row.type}:${row.name}`, row.id]))

  function accountTypeId(name: string): string {
    const id = accountTypeByName.get(name)
    if (!id) throw new Error(`Demo fixture expected a default account type named "${name}".`)
    return id
  }
  function categoryId(name: string, type: 'INCOME' | 'EXPENSE'): string {
    const id = categoryByName.get(`${type}:${name}`)
    if (!id) throw new Error(`Demo fixture expected a default ${type} category named "${name}".`)
    return id
  }

  // --- Accounts ------------------------------------------------------------
  const accountIds = new Map<AccountKey, string>()
  for (const spec of ACCOUNTS) {
    const account = await createFinancialAccount(userId, {
      name: spec.name,
      accountTypeId: accountTypeId(spec.type),
      initialBalance: spec.initialBalance,
      currency: spec.currency,
      description: 'Demo data',
    })
    accountIds.set(spec.key, account.id)
  }
  function accountId(key: AccountKey): string {
    const id = accountIds.get(key)
    if (!id) throw new Error(`Demo fixture never created the "${key}" account.`)
    return id
  }

  // --- Transactions --------------------------------------------------------
  const currentMonth = getCalendarMonth(DEMO_TIMEZONE, now)
  // Today, in the demo zone — the anchor every date below is derived from.
  const today = todayCalendarDateInZone(DEMO_TIMEZONE, now)
  const todayDay = Number(today.slice(8, 10))
  const months: CalendarMonth[] = []
  for (let back = MONTHS_OF_HISTORY - 1; back >= 0; back -= 1) {
    months.push(addCalendarMonths(currentMonth, -back))
  }

  let transactions = 0
  for (const month of months) {
    const isCurrent = month.year === currentMonth.year && month.month === currentMonth.month
    // Never a future date, and never the 31st of a 30-day month.
    const lastUsableDay = isCurrent ? todayDay : daysInCalendarMonth(month)
    for (const entry of MONTHLY_TRANSACTIONS) {
      const day = Math.min(entry.day, lastUsableDay)
      await createTransaction(
        userId,
        {
          accountId: accountId(entry.account),
          categoryId:
            entry.category === undefined
              ? undefined
              : categoryId(entry.category, entry.type === 'INCOME' ? 'INCOME' : 'EXPENSE'),
          type: entry.type,
          amount: entry.amount,
          date: instantFor(month, day, 8 + (entry.day % 12), now),
          note: entry.note,
        },
        provider,
      )
      transactions += 1
    }
  }
  // One CASH_IN this month, so the type is represented on both sides.
  await createTransaction(
    userId,
    {
      accountId: accountId('bank'),
      type: 'CASH_IN',
      amount: 5_000_000,
      date: instantFor(currentMonth, Math.min(2, todayDay), 9, now),
      note: 'Loan proceeds received',
    },
    provider,
  )
  transactions += 1

  // --- Transfers -----------------------------------------------------------
  // Two same-currency (the server derives `toAmount`), then one genuine
  // USD→VND leg. Its `toAmount` comes from the REAL current-rate policy — the
  // same function `createTransaction` snapshots from — never a constant: a
  // demo transfer whose effective rate was invented would misrepresent exactly
  // the figure the Transfers sheet exists to audit.
  await createTransfer(userId, {
    fromAccountId: accountId('bank'),
    toAccountId: accountId('cash'),
    fromAmount: 1_000_000,
    toAmount: 1_000_000,
    date: instantFor(currentMonth, Math.min(Math.max(todayDay - 9, 1), todayDay), 10, now),
    note: 'Weekly cash top-up',
  })
  await createTransfer(userId, {
    fromAccountId: accountId('bank'),
    toAccountId: accountId('ewallet'),
    fromAmount: 500_000,
    toAmount: 500_000,
    date: instantFor(currentMonth, Math.min(Math.max(todayDay - 4, 1), todayDay), 11, now),
    note: 'E-wallet top-up',
  })
  const usdVnd = await getUsableCurrentRate({ base: 'USD', quote: 'VND' }, provider)
  const usdSold = 100
  const vndReceived = usdVnd.rateDecimal.mul(usdSold).toDecimalPlaces(2).toNumber()
  await createTransfer(userId, {
    fromAccountId: accountId('usd'),
    toAccountId: accountId('bank'),
    fromAmount: usdSold,
    toAmount: vndReceived,
    date: instantFor(currentMonth, Math.min(Math.max(todayDay - 2, 1), todayDay), 14, now),
    note: 'Sold USD savings into VND',
  })
  const transfers = 3

  // --- Budgets (this month) ------------------------------------------------
  await createBudget(userId, {
    year: currentMonth.year,
    month: currentMonth.month,
    scope: 'OVERALL',
    amount: 30_000_000,
    currency: 'VND',
  })
  await createBudget(userId, {
    year: currentMonth.year,
    month: currentMonth.month,
    scope: 'CATEGORY',
    categoryId: categoryId('Food & Dining', 'EXPENSE'),
    amount: 4_000_000,
    currency: 'VND',
  })
  await createBudget(userId, {
    year: currentMonth.year,
    month: currentMonth.month,
    scope: 'CATEGORY',
    categoryId: categoryId('Transportation', 'EXPENSE'),
    amount: 1_000_000,
    currency: 'VND',
  })
  const budgets = 3

  // --- Savings goals -------------------------------------------------------
  // One in each currency, one part-way and one nearly there, so both the
  // progress bar and the ACHIEVED-threshold rendering have a subject.
  await createSavingsGoal(userId, {
    name: 'Emergency Fund',
    targetAmount: 50_000_000,
    currency: 'VND',
    currentProgress: 18_000_000,
    deadline: shiftCalendarDate(today, 365),
    note: 'Six months of expenses',
  })
  await createSavingsGoal(userId, {
    name: 'New Laptop',
    targetAmount: 2_000,
    currency: 'USD',
    currentProgress: 1_650,
    deadline: shiftCalendarDate(today, 120),
  })
  const savingsGoals = 2

  // --- Debt (receivable) with payments -------------------------------------
  const debt = await createDebt(userId, {
    direction: 'RECEIVABLE',
    person: 'Nguyen Van An',
    description: 'Lent for a motorbike repair',
    originalAmount: 5_000_000,
    currency: 'VND',
    dueDate: shiftCalendarDate(today, 45),
  })
  await recordDebtPayment(userId, debt.id, {
    amount: 2_000_000,
    date: shiftCalendarDate(today, -21),
    note: 'First instalment',
  })
  await recordDebtPayment(userId, debt.id, {
    amount: 1_000_000,
    date: shiftCalendarDate(today, -7),
  })
  const debts = 1
  const debtPayments = 2

  // --- Loan with payments --------------------------------------------------
  // `nextDueDate` starts two months back and each recorded instalment advances
  // it by one month, so after three payments the loan's next instalment falls
  // on the 1st of NEXT month — an upcoming due date, not an invented one.
  const loanStart = addCalendarMonths(currentMonth, -8)
  const firstUnpaidDue = addCalendarMonths(currentMonth, -2)
  const loan = await createLoan(userId, {
    lender: 'VPBank',
    principal: 120_000_000,
    currency: 'VND',
    interestRate: 9.5,
    startDate: calendarDate(loanStart, 1),
    termMonths: 36,
    paymentFrequency: 'MONTHLY',
    scheduledPaymentAmount: 4_000_000,
    nextDueDate: calendarDate(firstUnpaidDue, 1),
  })
  for (let back = 2; back >= 0; back -= 1) {
    const month = addCalendarMonths(currentMonth, -back)
    await recordLoanPayment(userId, loan.id, {
      totalAmount: 4_000_000,
      principalAmount: 3_050_000,
      interestAmount: 950_000,
      paymentDate: calendarDate(month, 1),
    })
  }
  const loans = 1
  const loanPayments = 3

  // --- Reminders (four frequencies) ----------------------------------------
  await createReminder(userId, DEMO_TIMEZONE, {
    title: 'Rent',
    type: 'EXPENSE',
    expectedAmount: 6_000_000,
    currency: 'VND',
    categoryId: categoryId('Bills & Utilities', 'EXPENSE'),
    accountId: accountId('bank'),
    frequency: 'MONTHLY',
    interval: 1,
    dayOfMonth: 5,
    startDate: calendarDate(months[0], 1),
  })
  await createReminder(userId, DEMO_TIMEZONE, {
    title: 'Internet bill',
    type: 'EXPENSE',
    expectedAmount: 200_000,
    currency: 'VND',
    categoryId: categoryId('Bills & Utilities', 'EXPENSE'),
    accountId: accountId('ewallet'),
    frequency: 'WEEKLY',
    interval: 1,
    startDate: shiftCalendarDate(today, -21),
  })
  await createReminder(userId, DEMO_TIMEZONE, {
    title: 'Motorbike insurance',
    type: 'EXPENSE',
    expectedAmount: 1_500_000,
    currency: 'VND',
    categoryId: categoryId('Other', 'EXPENSE'),
    frequency: 'YEARLY',
    interval: 1,
    month: 6,
    dayOfMonth: 15,
    startDate: shiftCalendarDate(today, -400),
  })
  await createReminder(userId, DEMO_TIMEZONE, {
    title: 'Tuition instalment',
    type: 'EXPENSE',
    expectedAmount: 3_000_000,
    currency: 'VND',
    categoryId: categoryId('Education', 'EXPENSE'),
    accountId: accountId('bank'),
    frequency: 'ONE_TIME',
    interval: 1,
    startDate: shiftCalendarDate(today, 12),
  })
  const reminders = 4

  // Occurrences are normally written lazily, on the first read of a reminder
  // page. Materialising them here is the same call that page makes, so the
  // demo dashboard shows a real upcoming/overdue list on its very first render
  // instead of an empty one.
  const reminderOccurrences = await materializeDueOccurrences(userId, DEMO_TIMEZONE, now)

  return {
    accountTypes: accountTypes.length,
    categories: categories.length,
    accounts: ACCOUNTS.length,
    transactions,
    transfers,
    budgets,
    savingsGoals,
    debts,
    debtPayments,
    loans,
    loanPayments,
    reminders,
    reminderOccurrences,
  }
}
