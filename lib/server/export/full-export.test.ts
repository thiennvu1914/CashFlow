import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
// A value import, not `import type`: the scan-count case below builds a bare
// workbook to run `buildBudgetsSheet` on its own.
import ExcelJS from 'exceljs'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

import { createDebt, recordDebtPayment, writeOffDebt } from '@/lib/server/services/debt'
import { closeLoan, createLoan, recordLoanPayment } from '@/lib/server/services/loan'
import {
  acknowledgeOccurrence,
  createReminder,
  dismissOccurrence,
  listUpcomingOccurrences,
  setReminderActive,
} from '@/lib/server/services/reminder'
import { archiveSavingsGoal, createSavingsGoal } from '@/lib/server/services/savings-goal'

import { buildBudgetsSheet } from './build-budgets-sheet'
import { FULL_EXPORT_SHEET_BUILDERS, buildFullWorkbook } from './sheet-registry'
import {
  TEST_TIMEZONE,
  cleanupExportUsers,
  createExportUser,
  failingFxProvider,
  fakeFxProvider,
  makeExportContext,
  seedTransaction,
  utcDayStart,
} from './test-fixtures'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * What this suite protects is the promise "export all data": every account
 * including the archived ones, every transaction with no 200-row ceiling, every
 * transfer — and no fabricated FX number anywhere when the rate is missing.
 */

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const found = workbook.getWorksheet(name)
  if (!found) throw new Error(`No ${name} sheet in the workbook`)
  return found
}

/** Column A values of every data row (the header row dropped). */
function firstColumn(worksheet: ExcelJS.Worksheet): unknown[] {
  const values: unknown[] = []
  worksheet.eachRow((row, index) => {
    if (index > 1) values.push(row.getCell(1).value)
  })
  return values
}

function labelledRow(worksheet: ExcelJS.Worksheet, label: string): ExcelJS.Row {
  let found: ExcelJS.Row | undefined
  worksheet.eachRow((row) => {
    if (found === undefined && row.getCell(1).value === label) found = row
  })
  if (!found) throw new Error(`No row labelled ${JSON.stringify(label)} in ${worksheet.name}`)
  return found
}

/**
 * The first *data* row whose `column` holds `value`.
 *
 * The Phase 6 sheets do not all put a name in column A — the Debts sheet leads
 * with the direction — so a record is located by the cell that identifies it
 * rather than by a row index, which a later seed or a changed sort would shift
 * silently.
 */
function rowBy(worksheet: ExcelJS.Worksheet, column: number, value: unknown): ExcelJS.Row {
  let found: ExcelJS.Row | undefined
  worksheet.eachRow((row, index) => {
    if (index > 1 && found === undefined && row.getCell(column).value === value) found = row
  })
  if (!found) {
    throw new Error(`No row with ${JSON.stringify(value)} in column ${column} of ${worksheet.name}`)
  }
  return found
}

/** Every sheet of the full workbook, in the order spec §12 lists them. */
const FULL_EXPORT_SHEETS = [
  'Summary',
  'Accounts',
  'Transactions',
  'Transfers',
  'Budgets',
  'Savings Goals',
  'Debts',
  'Debt Payments',
  'Loans',
  'Loan Payments',
  'Reminders',
]

/**
 * The instant every Phase 6 case exports "as of": 15 March 2026, 12:00 in
 * `Asia/Ho_Chi_Minh`.
 *
 * Fixed, and comfortably inside the day at both ends, because the four derived
 * statuses on those sheets (OVERDUE, PAID, PARTIALLY_PAID, PAID_OFF) are decided
 * against `todayCalendarDateInZone(ctx.timezone, ctx.now)`. A real `new Date()`
 * would make "due on 30 April" eventually overdue and this suite would start
 * failing on its own one day.
 */
const EXPORT_NOW = new Date('2026-03-15T05:00:00Z')

describe('full export workbook', () => {
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Today's USD/VND row is the shared cache `getLatestRate` serves from, so a
    // rate left by an earlier test would pin the rate this one's fake provider
    // is supposed to supply. Nothing here *depends* on the cache being cold any
    // more — every sheet is handed `ctx.fx` — but a stale row would still make
    // an exact-rate assertion read the wrong number.
    await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupExportUsers(createdUserIds.splice(0))
  })

  async function setup() {
    const fixture = await createExportUser('VND')
    createdUserIds.push(fixture.userId)
    return fixture
  }

  /** An account that once held money, is now empty, and has been archived —
   *  the exact row a full export must still carry. */
  async function archivedAccountWithHistory(s: Awaited<ReturnType<typeof setup>>) {
    const account = await prisma.financialAccount.create({
      data: {
        userId: s.userId,
        name: 'Closed card',
        accountTypeId: s.accountTypeId,
        initialBalance: 0,
        currency: 'VND',
      },
    })
    await seedTransaction(s.userId, {
      accountId: account.id,
      type: 'CASH_IN',
      amount: 5_000,
      date: new Date('2026-01-05T03:00:00Z'),
      note: 'opening float',
    })
    await seedTransaction(s.userId, {
      accountId: account.id,
      type: 'CASH_OUT',
      amount: 5_000,
      date: new Date('2026-01-06T03:00:00Z'),
      note: 'closed out',
    })
    // Zeroed first, then archived directly: Task 15's service refuses a
    // non-zero balance, and this suite is about the export, not the archive.
    await prisma.financialAccount.update({
      where: { userId_id: { userId: s.userId, id: account.id } },
      data: { status: 'ARCHIVED' },
    })
    return account
  }

  /**
   * An ACTIVE goal in VND with a deadline, and an ARCHIVED one in USD that was
   * over-saved — the two rows that pin the "history is never omitted",
   * "own currency" and "unclamped percentage" rules at once.
   */
  async function seedSavingsGoals(userId: string) {
    const emergency = await createSavingsGoal(userId, {
      name: 'Emergency fund',
      targetAmount: 10_000_000,
      currency: 'VND',
      deadline: '2026-12-31',
      note: 'three months of expenses',
      currentProgress: 2_500_000,
    })
    const laptop = await createSavingsGoal(userId, {
      name: 'New laptop',
      targetAmount: 1_000,
      currency: 'USD',
      // Over the target on purpose: ACHIEVED, then archived, and 120 % is a
      // figure the sheet must be able to state.
      currentProgress: 1_200,
    })
    await archiveSavingsGoal(userId, laptop.id)
    return { emergency, laptop }
  }

  /**
   * A part-paid receivable, a written-off payable that had already been paid
   * down, and a receivable settled *after* its due date.
   */
  async function seedDebts(userId: string) {
    const receivable = await createDebt(userId, {
      direction: 'RECEIVABLE',
      person: 'An',
      originalAmount: 1_000_000,
      currency: 'VND',
      dueDate: '2026-04-30',
      description: 'lent for the deposit',
      notes: 'paying in instalments',
    })
    await recordDebtPayment(userId, receivable.id, {
      amount: 300_000,
      date: '2026-03-05',
      note: 'first instalment',
    })
    await recordDebtPayment(userId, receivable.id, { amount: 200_000, date: '2026-03-06' })

    const payable = await createDebt(userId, {
      direction: 'PAYABLE',
      person: 'Binh',
      originalAmount: 400,
      currency: 'USD',
    })
    // Paid down first, THEN written off: a written-off debt takes no further
    // payments, and the point of this row is that the history survives the
    // write-off.
    await recordDebtPayment(userId, payable.id, { amount: 100, date: '2026-03-04' })
    await writeOffDebt(userId, payable.id)

    const settled = await createDebt(userId, {
      direction: 'RECEIVABLE',
      person: 'Chi',
      originalAmount: 100_000,
      currency: 'VND',
      // Behind `EXPORT_NOW`, and settled two weeks late: a repaid debt is
      // repaid, never overdue.
      dueDate: '2026-03-01',
    })
    await recordDebtPayment(userId, settled.id, { amount: 100_000, date: '2026-03-07' })
    return { receivable, payable, settled }
  }

  /** An ACTIVE VND loan with one instalment, and a CLOSED USD one that also has
   *  a payment behind it. */
  async function seedLoans(userId: string) {
    const active = await createLoan(userId, {
      lender: 'Sacombank',
      principal: 1_000_000,
      currency: 'VND',
      // Three decimal places, which is exactly what `Decimal(6, 3)` holds — so
      // a cell that lost a digit or scaled by 100 would show.
      interestRate: 7.125,
      startDate: '2026-01-01',
      termMonths: 12,
      paymentFrequency: 'MONTHLY',
      scheduledPaymentAmount: 90_000,
      nextDueDate: '2026-03-01',
      notes: 'car loan',
    })
    await recordLoanPayment(userId, active.id, {
      totalAmount: 90_000,
      principalAmount: 80_000,
      interestAmount: 10_000,
      paymentDate: '2026-03-01',
      note: 'March instalment',
    })

    const closed = await createLoan(userId, {
      lender: 'Family',
      principal: 200,
      currency: 'USD',
      interestRate: 0,
      startDate: '2026-02-01',
      termMonths: 6,
      paymentFrequency: 'MONTHLY',
      scheduledPaymentAmount: 50,
      nextDueDate: '2026-03-01',
    })
    await recordLoanPayment(userId, closed.id, {
      totalAmount: 50,
      principalAmount: 40,
      interestAmount: 10,
      paymentDate: '2026-03-02',
    })
    await closeLoan(userId, closed.id)
    return { active, closed }
  }

  /**
   * An active monthly reminder with one dismissed occurrence and one still
   * pending, and a paused one-time reminder whose single occurrence was
   * acknowledged.
   *
   * The occurrences are materialized by `listUpcomingOccurrences` — the page's
   * own read, at the fixed `EXPORT_NOW` — because the export itself must never
   * write one.
   */
  async function seedReminders(userId: string, s: Awaited<ReturnType<typeof setup>>) {
    const rent = await createReminder(userId, TEST_TIMEZONE, {
      title: 'Rent',
      type: 'EXPENSE',
      expectedAmount: 5_000_000,
      currency: 'VND',
      categoryId: s.expenseCategoryId,
      accountId: s.vndAccountId,
      frequency: 'MONTHLY',
      interval: 1,
      startDate: '2026-03-01',
      note: 'landlord transfers',
    })
    const passport = await createReminder(userId, TEST_TIMEZONE, {
      title: 'Passport renewal',
      type: 'EXPENSE',
      expectedAmount: 200,
      currency: 'USD',
      frequency: 'ONE_TIME',
      interval: 1,
      startDate: '2026-03-10',
    })

    // From 1 March, monthly, read on 15 March: 1 March and 1 April are inside
    // the window, and the one-time reminder's single day is too.
    const upcoming = await listUpcomingOccurrences(userId, TEST_TIMEZONE, EXPORT_NOW)
    const forRent = upcoming.filter((occurrence) => occurrence.reminderId === rent.id)
    const forPassport = upcoming.filter((occurrence) => occurrence.reminderId === passport.id)
    expect(forRent).toHaveLength(2)
    expect(forPassport).toHaveLength(1)

    await dismissOccurrence(userId, forRent[0].id, EXPORT_NOW)
    await acknowledgeOccurrence(userId, forPassport[0].id, EXPORT_NOW)
    // Paused AFTER its occurrence was answered — the row and its history stay.
    await setReminderActive(userId, passport.id, false)
    return { rent, passport }
  }

  it('produces every sheet spec §12 lists, in registry order', async () => {
    const s = await setup()
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const workbook = await buildFullWorkbook(ctx)

    expect(workbook.worksheets.map((w) => w.name)).toEqual(FULL_EXPORT_SHEETS)
    // The array is the single source of truth, and Phase 6 completed it.
    expect(FULL_EXPORT_SHEET_BUILDERS).toHaveLength(11)
  })

  it('includes archived accounts, their status, and their history', async () => {
    const s = await setup()
    const archived = await archivedAccountWithHistory(s)
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    const workbook = await buildFullWorkbook(ctx)

    const accounts = sheet(workbook, 'Accounts')
    expect(firstColumn(accounts)).toEqual(['Wallet', 'Dollar savings', 'Closed card'])
    const archivedRow = labelledRow(accounts, 'Closed card')
    expect(archivedRow.getCell(4).value).toBe('ARCHIVED')
    expect(labelledRow(accounts, 'Wallet').getCell(4).value).toBe('ACTIVE')
    // Archiving is a no-op on the ledger: the derived balance is still zero.
    expect(archivedRow.getCell(6).value).toBe(0)

    // And the archived account's own history is still in the workbook.
    const transactions = sheet(workbook, 'Transactions')
    const notes: unknown[] = []
    transactions.eachRow((row, index) => {
      if (index > 1) notes.push(row.getCell(13).value)
    })
    expect(notes).toEqual(['opening float', 'closed out'])
    expect(await prisma.transaction.count({ where: { accountId: archived.id } })).toBe(2)
  })

  it('writes every transaction — 205 rows, no 200-row truncation', async () => {
    const s = await setup()
    const date = new Date('2026-03-10T05:00:00Z')
    await prisma.transaction.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        userId: s.userId,
        accountId: s.vndAccountId,
        categoryId: s.expenseCategoryId,
        type: 'EXPENSE' as const,
        amount: new Prisma.Decimal(index + 1),
        currency: 'VND' as const,
        date,
        vndPerUsdAtEntry: new Prisma.Decimal(25000),
        fxRateFetchedAt: date,
        fxRateEffectiveAt: utcDayStart(date),
        fxRateSource: 'export-seeded',
      })),
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    const workbook = await buildFullWorkbook(ctx)

    // Header row plus 205 data rows — the bounded UI list would have stopped
    // at 200 and the workbook would have looked complete. `actualRowCount`
    // counts rows carrying values, so a stray blank cannot pad the tally.
    expect(sheet(workbook, 'Transactions').actualRowCount).toBe(206)
    expect(labelledRow(sheet(workbook, 'Summary'), 'Transactions').getCell(2).value).toBe(205)
  })

  it('lists transfers with both legs, their currencies and the rate used', async () => {
    const s = await setup()
    await prisma.transfer.create({
      data: {
        userId: s.userId,
        fromAccountId: s.vndAccountId,
        toAccountId: s.usdAccountId,
        fromAmount: new Prisma.Decimal(2_550_000),
        toAmount: new Prisma.Decimal(100),
        exchangeRateUsed: new Prisma.Decimal(100).div(2_550_000),
        date: new Date('2026-03-12T05:00:00Z'),
        note: 'to savings',
      },
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    const transfers = sheet(await buildFullWorkbook(ctx), 'Transfers')

    expect(transfers.actualRowCount).toBe(2)
    const row = transfers.getRow(2)
    expect(row.getCell(1).value).toEqual(new Date(Date.UTC(2026, 2, 12, 12, 0)))
    expect(row.getCell(2).value).toBe('Wallet')
    expect(row.getCell(3).value).toBe('Dollar savings')
    expect(row.getCell(4).value).toBe(2_550_000)
    expect(row.getCell(5).value).toBe('VND')
    expect(row.getCell(6).value).toBe(100)
    expect(row.getCell(7).value).toBe('USD')
    expect(row.getCell(9).value).toBe('to savings')
  })

  it('converts each transaction at its own snapshot rate, not at the current one', async () => {
    const s = await setup()
    // A USD row that snapshotted 25,500 while today's usable rate is 26,000.
    const tx = await seedTransaction(s.userId, {
      accountId: s.usdAccountId,
      categoryId: s.expenseCategoryId,
      amount: 100,
      currency: 'USD',
      date: new Date('2026-03-10T05:00:00Z'),
      vndPerUsdAtEntry: 25_500,
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider(26_000) })
    expect(ctx.fx?.rateDecimal.toNumber()).toBe(26_000)

    const transactions = sheet(await buildFullWorkbook(ctx), 'Transactions')
    const row = transactions.getRow(2)

    // The row is identifiable...
    expect(row.getCell(1).value).toBe(tx.id)
    // ...the native amount is untouched...
    expect(row.getCell(6).value).toBe(100)
    expect(row.getCell(7).value).toBe('USD')
    // ...and the display-currency column is 100 × 25,500, the row's own rate —
    // 100 × 26,000 would mean history moved when this morning's rate did.
    expect(row.getCell(8).value).toBe(2_550_000)
    expect(row.getCell(9).value).toBe(25_500)
    // Each amount column is formatted by the currency it is denominated in.
    expect(row.getCell(6).numFmt).toBe('#,##0.00')
    expect(row.getCell(8).numFmt).toBe('#,##0')
    expect(row.getCell(9).numFmt).toBe('#,##0.000000')
  })

  it('leaves converted balances blank and says so when no usable rate exists', async () => {
    const s = await setup()
    await seedTransaction(s.userId, {
      accountId: s.usdAccountId,
      type: 'CASH_IN',
      amount: 100,
      currency: 'USD',
      date: new Date('2026-03-10T05:00:00Z'),
    })

    // A provider that refuses, so the context resolves no rate at all.
    const ctx = await makeExportContext(s.userId, { providerOverride: failingFxProvider })
    expect(ctx.fx).toBeNull()

    const workbook = await buildFullWorkbook(ctx)

    // Nothing in the workbook went looking for a rate of its own: the sheets
    // are handed `ctx.fx` and use it, so this outcome does not depend on the
    // shared `ExchangeRate` cache happening to be cold.
    expect(fetchSpy).not.toHaveBeenCalled()

    const accounts = sheet(workbook, 'Accounts')
    const usdRow = labelledRow(accounts, 'Dollar savings')
    // The native balance is still exact...
    expect(usdRow.getCell(6).value).toBe(100)
    // ...and the display-currency column is empty rather than invented.
    expect(usdRow.getCell(7).value).toBeNull()

    const summary = sheet(workbook, 'Summary')
    expect(String(labelledRow(summary, 'FX rate').getCell(2).value)).toContain('unavailable')
    expect(labelledRow(summary, 'Total account balance').getCell(2).value).toBeNull()
    expect(labelledRow(summary, 'Net worth').getCell(2).value).toBeNull()
  })

  it('summarises counts and the current position when a rate is available', async () => {
    const s = await setup()
    await archivedAccountWithHistory(s)
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      type: 'CASH_IN',
      amount: 1_000_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    await prisma.transfer.create({
      data: {
        userId: s.userId,
        fromAccountId: s.vndAccountId,
        toAccountId: s.usdAccountId,
        fromAmount: new Prisma.Decimal(260_000),
        toAmount: new Prisma.Decimal(10),
        exchangeRateUsed: new Prisma.Decimal(10).div(260_000),
        date: new Date('2026-03-12T05:00:00Z'),
      },
    })
    // A rate with a fractional part, so the total can only come out right if
    // this exact number reached the arithmetic.
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider(26_000.5) })

    const summary = sheet(await buildFullWorkbook(ctx), 'Summary')

    expect(labelledRow(summary, 'Timezone').getCell(2).value).toBe('Asia/Ho_Chi_Minh')
    expect(labelledRow(summary, 'Display currency').getCell(2).value).toBe('VND')
    expect(labelledRow(summary, 'Active accounts').getCell(2).value).toBe(2)
    expect(labelledRow(summary, 'Archived accounts').getCell(2).value).toBe(1)
    expect(labelledRow(summary, 'Transactions').getCell(2).value).toBe(3)
    expect(labelledRow(summary, 'Transfers').getCell(2).value).toBe(1)
    // The FX line and the total are two statements about ONE rate: 740,000 in
    // the VND wallet plus 10 USD × 26,000.5. A second lookup answering 26,000
    // would total 1,000,000 and the line would still read 26,000.5 — this pins
    // both cells to the same number so that divergence cannot pass.
    expect(labelledRow(summary, 'Total account balance').getCell(2).value).toBe(1_000_005)
    expect(labelledRow(summary, 'Net worth').getCell(2).value).toBe(1_000_005)
    expect(String(labelledRow(summary, 'FX rate').getCell(2).value)).toContain('26000.5')
    // And no sheet went shopping for a rate of its own.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports Net worth as the accounts plus receivables less payables and loan principal', async () => {
    const s = await setup()
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      type: 'CASH_IN',
      amount: 1_000_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    // A receivable in the OTHER currency, so the figure can only come out right
    // if it was converted at the workbook's one rate before being added.
    await prisma.debt.create({
      data: {
        userId: s.userId,
        direction: 'RECEIVABLE',
        person: 'An',
        originalAmount: new Prisma.Decimal('100'),
        currency: 'USD',
      },
    })
    await prisma.debt.create({
      data: {
        userId: s.userId,
        direction: 'PAYABLE',
        person: 'Binh',
        originalAmount: new Prisma.Decimal('100000'),
        currency: 'VND',
      },
    })
    // Written off, and enormous: if the sheet counted it the total would be
    // unmistakably wrong rather than subtly so.
    await prisma.debt.create({
      data: {
        userId: s.userId,
        direction: 'RECEIVABLE',
        person: 'Never paying',
        originalAmount: new Prisma.Decimal('9000000'),
        currency: 'VND',
        status: 'WRITTEN_OFF',
      },
    })
    const loan = await prisma.loan.create({
      data: {
        userId: s.userId,
        lender: 'Bank',
        principal: new Prisma.Decimal('200000'),
        currency: 'VND',
        interestRate: new Prisma.Decimal('5'),
        startDate: new Date('2026-01-01T00:00:00Z'),
        termMonths: 12,
        paymentFrequency: 'MONTHLY',
        scheduledPaymentAmount: new Prisma.Decimal('20000'),
        nextDueDate: new Date('2026-04-01T00:00:00Z'),
        dueDayOfMonth: 1,
      },
    })
    await prisma.loanPayment.create({
      data: {
        userId: s.userId,
        loanId: loan.id,
        // Only the 50,000 of principal pays the loan down; the 25,000 of
        // interest is the cost of borrowing and moves nothing.
        totalAmount: new Prisma.Decimal('75000'),
        principalAmount: new Prisma.Decimal('50000'),
        interestAmount: new Prisma.Decimal('25000'),
        paymentDate: new Date('2026-03-01T00:00:00Z'),
      },
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider(26_000) })

    const summary = sheet(await buildFullWorkbook(ctx), 'Summary')

    // The accounts alone — unchanged by any of the above.
    expect(labelledRow(summary, 'Total account balance').getCell(2).value).toBe(1_000_000)
    // 1,000,000 + (100 USD × 26,000) − 100,000 − 150,000 of principal still
    // outstanding. The written-off receivable contributes nothing.
    expect(labelledRow(summary, 'Net worth').getCell(2).value).toBe(3_350_000)
    // And the workbook's single resolved rate is what did the converting.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes each budget in its own currency, from historical rates and no current one', async () => {
    const s = await setup()
    // Two budgets for the same month, in different currencies: one whole-month
    // VND target and one USD target on Food.
    await prisma.budget.create({
      data: {
        userId: s.userId,
        year: 2026,
        month: 3,
        scope: 'OVERALL',
        amount: new Prisma.Decimal(1_000_000),
        currency: 'VND',
      },
    })
    await prisma.budget.create({
      data: {
        userId: s.userId,
        year: 2026,
        month: 3,
        scope: 'CATEGORY',
        categoryId: s.expenseCategoryId,
        amount: new Prisma.Decimal(100),
        currency: 'USD',
      },
    })

    // March spending, both rows snapshotting 25,500 at entry.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 300_000,
      date: new Date('2026-03-10T05:00:00Z'),
      vndPerUsdAtEntry: 25_500,
    })
    await seedTransaction(s.userId, {
      accountId: s.usdAccountId,
      categoryId: s.expenseCategoryId,
      amount: 10,
      currency: 'USD',
      date: new Date('2026-03-11T05:00:00Z'),
      vndPerUsdAtEntry: 25_500,
    })
    // A balance movement, not spending — it must reach neither budget.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      type: 'CASH_OUT',
      amount: 900_000,
      date: new Date('2026-03-12T05:00:00Z'),
      vndPerUsdAtEntry: 25_500,
    })

    // Today's usable rate is deliberately far from 25,500: if any figure below
    // came from it rather than from the rows' own snapshots, it would show.
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider(30_000) })
    const workbook = await buildFullWorkbook(ctx)
    const budgets = sheet(workbook, 'Budgets')

    // Header plus the two budgets, OVERALL first (the Budgets page's order).
    expect(budgets.actualRowCount).toBe(3)

    const overallRow = budgets.getRow(2)
    expect(overallRow.getCell(1).value).toBe(2026)
    expect(overallRow.getCell(2).value).toBe(3)
    expect(overallRow.getCell(3).value).toBe('OVERALL')
    expect(overallRow.getCell(4).value).toBe('')
    expect(overallRow.getCell(5).value).toBe(1_000_000)
    expect(overallRow.getCell(6).value).toBe('VND')
    // 300,000 + 10 × 25,500 — the USD row at ITS OWN snapshot rate. Today's
    // 30,000 would have made this 600,000.
    expect(overallRow.getCell(7).value).toBe(555_000)
    expect(overallRow.getCell(8).value).toBe(445_000)
    expect(overallRow.getCell(9).value).toBeCloseTo(0.555, 6)
    expect(overallRow.getCell(10).value).toBe('Over half used')
    // VND has no circulating subunit — the budget's currency decides, not the
    // user's display currency (which happens to agree here; the USD row below
    // is where the two diverge).
    expect(overallRow.getCell(5).numFmt).toBe('#,##0')
    expect(overallRow.getCell(9).numFmt).toBe('0%')

    const foodRow = budgets.getRow(3)
    expect(foodRow.getCell(3).value).toBe('CATEGORY')
    expect(foodRow.getCell(4).value).toBe('Food')
    expect(foodRow.getCell(5).value).toBe(100)
    expect(foodRow.getCell(6).value).toBe('USD')
    // The same two expenses restated in USD at 25,500: 300,000 ÷ 25,500 + 10.
    expect(foodRow.getCell(7).value).toBeCloseTo(300_000 / 25_500 + 10, 6)
    expect(foodRow.getCell(8).value).toBeCloseTo(100 - (300_000 / 25_500 + 10), 6)
    expect(foodRow.getCell(10).value).toBe('Healthy')
    // Cents, in a workbook whose display currency is VND.
    expect(foodRow.getCell(5).numFmt).toBe('#,##0.00')
    expect(foodRow.getCell(7).numFmt).toBe('#,##0.00')
    expect(foodRow.getCell(8).numFmt).toBe('#,##0.00')

    // Neither budget went looking for a rate, and the Budgets sheet asked for
    // none of its own: `ctx.fx` is resolved once and this sheet reads it never.
    expect(fetchSpy).not.toHaveBeenCalled()

    // The rest of the workbook is untouched by the new sheet — three
    // transactions counted, the two budget rows included in neither tally.
    const summary = sheet(workbook, 'Summary')
    expect(labelledRow(summary, 'Transactions').getCell(2).value).toBe(3)
    expect(labelledRow(summary, 'Transfers').getCell(2).value).toBe(0)
    expect(labelledRow(summary, 'Active accounts').getCell(2).value).toBe(2)
  })

  it('scans the ledger once per distinct budgeted month, never once per budget', async () => {
    const s = await setup()
    // Three budgets across TWO months — the shape that tells a per-month scan
    // apart from a per-budget one.
    for (const budget of [
      { year: 2026, month: 3, scope: 'OVERALL' as const, categoryId: null },
      { year: 2026, month: 3, scope: 'CATEGORY' as const, categoryId: s.expenseCategoryId },
      { year: 2026, month: 4, scope: 'OVERALL' as const, categoryId: null },
    ]) {
      await prisma.budget.create({
        data: {
          userId: s.userId,
          ...budget,
          amount: new Prisma.Decimal(1_000_000),
          currency: 'VND',
        },
      })
    }
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 100_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    // The spy is scoped to `buildBudgetsSheet` alone rather than to
    // `buildFullWorkbook`: the Summary, Accounts and Transactions sheets run
    // `transaction.findMany` calls of their own, which would drown the number
    // this case is about.
    const workbook = new ExcelJS.Workbook()
    const findMany = vi.spyOn(prisma.transaction, 'findMany')
    await buildBudgetsSheet(workbook, ctx)
    const scans = findMany.mock.calls.length
    findMany.mockRestore()

    // Two months, so two scans — `getBudgetProgressForMonth` answers for every
    // budget in the month it scans. A regression to one call per budget reads 3.
    expect(scans).toBe(2)
    // And all three budgets are still on the sheet (header plus three rows).
    expect(sheet(workbook, 'Budgets').actualRowCount).toBe(4)
  })

  it('keeps a budget filed under an archived category, and marks it as archived', async () => {
    const s = await setup()
    await prisma.budget.create({
      data: {
        userId: s.userId,
        year: 2026,
        month: 3,
        scope: 'CATEGORY',
        categoryId: s.expenseCategoryId,
        amount: new Prisma.Decimal(500_000),
        currency: 'VND',
      },
    })
    // Archived AFTER the budget was set — which does not erase the target or
    // the history filed under it.
    await prisma.category.update({
      where: { userId_id: { userId: s.userId, id: s.expenseCategoryId } },
      data: { status: 'ARCHIVED' },
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    const row = sheet(await buildFullWorkbook(ctx), 'Budgets').getRow(2)

    // Still there, still named, and the state is on the row rather than implied
    // by its absence.
    expect(row.getCell(4).value).toBe('Food (archived)')
    expect(row.getCell(5).value).toBe(500_000)
    expect(row.getCell(7).value).toBe(0)
  })

  it('bolds and freezes every sheet header and formats VND without a subunit', async () => {
    const s = await setup()
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 1_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    const workbook = await buildFullWorkbook(ctx)

    for (const name of FULL_EXPORT_SHEETS) {
      const worksheet = sheet(workbook, name)
      expect(worksheet.getRow(1).font?.bold).toBe(true)
      // Frozen, so the headers stay visible while scrolling a ledger that can
      // run to thousands of rows. `ySplit` lives only on the frozen/split
      // members of the view union, so the narrowing is asserted first.
      const view = worksheet.views[0]
      expect(view.state).toBe('frozen')
      if (view.state !== 'frozen') throw new Error(`${name} header is not frozen`)
      expect(view.ySplit).toBe(1)
    }

    // VND has no circulating subunit, so two decimal places would be false
    // precision on every row; USD keeps its cents (asserted above).
    const row = sheet(workbook, 'Transactions').getRow(2)
    expect(row.getCell(6).numFmt).toBe('#,##0')
    expect(row.getCell(8).numFmt).toBe('#,##0')
    const account = labelledRow(sheet(workbook, 'Accounts'), 'Dollar savings')
    expect(account.getCell(6).numFmt).toBe('#,##0.00')
    // The display-currency column always carries the DISPLAY currency's format,
    // whatever the account is held in.
    expect(account.getCell(7).numFmt).toBe('#,##0')
  })

  it('writes every savings goal in its own currency, archived ones included', async () => {
    const s = await setup()
    await seedSavingsGoals(s.userId)
    // A rate is available and deliberately unlike anything below: nothing on
    // this sheet may be restated at it.
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(30_000),
    })

    const goals = sheet(await buildFullWorkbook(ctx), 'Savings Goals')

    // Header plus both goals — the archived one is not dropped.
    expect(goals.actualRowCount).toBe(3)

    const emergency = rowBy(goals, 1, 'Emergency fund')
    expect(emergency.getCell(2).value).toBe(10_000_000)
    expect(emergency.getCell(3).value).toBe(2_500_000)
    expect(emergency.getCell(4).value).toBe(7_500_000)
    expect(emergency.getCell(5).value).toBeCloseTo(0.25, 6)
    expect(emergency.getCell(6).value).toBe('VND')
    // A deadline carrier goes straight through: the calendar day the user
    // picked, at UTC midnight, whatever zone the reader is in.
    expect(emergency.getCell(7).value).toEqual(new Date(Date.UTC(2026, 11, 31)))
    expect(emergency.getCell(8).value).toBe('In progress')
    expect(emergency.getCell(9).value).toBe('three months of expenses')
    // VND has no circulating subunit — the GOAL's currency decides the format,
    // not the user's display currency.
    expect(emergency.getCell(2).numFmt).toBe('#,##0')
    expect(emergency.getCell(5).numFmt).toBe('0%')
    expect(emergency.getCell(7).numFmt).toBe('yyyy-mm-dd')

    const laptop = rowBy(goals, 1, 'New laptop')
    expect(laptop.getCell(2).value).toBe(1_000)
    expect(laptop.getCell(3).value).toBe(1_200)
    // Nothing left to save — and the over-saving is stated as 120 % rather than
    // as a negative remainder.
    expect(laptop.getCell(4).value).toBe(0)
    expect(laptop.getCell(5).value).toBeCloseTo(1.2, 6)
    expect(laptop.getCell(6).value).toBe('USD')
    // No deadline: blank, never a date this goal never had.
    expect(laptop.getCell(7).value).toBeNull()
    // Archived, with its state on the row rather than implied by its absence.
    expect(laptop.getCell(8).value).toBe('Archived')
    expect(laptop.getCell(9).value).toBe('')
    // Cents, in a workbook whose display currency is VND.
    expect(laptop.getCell(2).numFmt).toBe('#,##0.00')
    expect(laptop.getCell(4).numFmt).toBe('#,##0.00')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes every debt with its derived outstanding, written-off ones included', async () => {
    const s = await setup()
    await seedDebts(s.userId)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const debts = sheet(await buildFullWorkbook(ctx), 'Debts')

    // Header plus all three, the written-off one included.
    expect(debts.actualRowCount).toBe(4)

    const an = rowBy(debts, 2, 'An')
    expect(an.getCell(1).value).toBe('Receivable')
    expect(an.getCell(3).value).toBe(1_000_000)
    // 300,000 + 200,000 paid, so 500,000 still owed — exactly original − paid.
    expect(an.getCell(4).value).toBe(500_000)
    expect(an.getCell(5).value).toBe(500_000)
    expect(an.getCell(6).value).toBe('VND')
    expect(an.getCell(7).value).toEqual(new Date(Date.UTC(2026, 3, 30)))
    // Something paid, and nothing late on 15 March.
    expect(an.getCell(8).value).toBe('Partly paid')
    expect(an.getCell(9).value).toBe('lent for the deposit')
    expect(an.getCell(10).value).toBe('paying in instalments')
    expect(an.getCell(3).numFmt).toBe('#,##0')
    expect(an.getCell(7).numFmt).toBe('yyyy-mm-dd')

    const binh = rowBy(debts, 2, 'Binh')
    expect(binh.getCell(1).value).toBe('Payable')
    expect(binh.getCell(3).value).toBe(400)
    expect(binh.getCell(4).value).toBe(100)
    // NOT zeroed by the write-off: what happened stays readable, and only Net
    // Worth stops counting it.
    expect(binh.getCell(5).value).toBe(300)
    // No agreed due date: blank, never today's.
    expect(binh.getCell(7).value).toBeNull()
    expect(binh.getCell(8).value).toBe('Written off')
    // Cents, in a workbook whose display currency is VND.
    expect(binh.getCell(5).numFmt).toBe('#,##0.00')

    const chi = rowBy(debts, 2, 'Chi')
    expect(chi.getCell(5).value).toBe(0)
    // Settled six days after it fell due — repaid is repaid, never overdue.
    expect(chi.getCell(8).value).toBe('Paid')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lists every debt payment in its parent debt currency', async () => {
    const s = await setup()
    await seedDebts(s.userId)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const payments = sheet(await buildFullWorkbook(ctx), 'Debt Payments')

    // Header plus all four, oldest first — including the one against the debt
    // that was later written off, which really was paid.
    expect(payments.actualRowCount).toBe(5)
    expect(firstColumn(payments)).toEqual([
      new Date(Date.UTC(2026, 2, 4)),
      new Date(Date.UTC(2026, 2, 5)),
      new Date(Date.UTC(2026, 2, 6)),
      new Date(Date.UTC(2026, 2, 7)),
    ])

    // A payment has no currency of its own — it inherits the debt's, and the
    // format follows the PARENT, not the user's display currency.
    const usd = payments.getRow(2)
    expect(usd.getCell(2).value).toBe('Binh')
    expect(usd.getCell(3).value).toBe('Payable')
    expect(usd.getCell(4).value).toBe(100)
    expect(usd.getCell(5).value).toBe('USD')
    expect(usd.getCell(4).numFmt).toBe('#,##0.00')
    expect(usd.getCell(1).numFmt).toBe('yyyy-mm-dd')

    const vnd = payments.getRow(3)
    expect(vnd.getCell(2).value).toBe('An')
    expect(vnd.getCell(3).value).toBe('Receivable')
    expect(vnd.getCell(4).value).toBe(300_000)
    expect(vnd.getCell(5).value).toBe('VND')
    expect(vnd.getCell(6).value).toBe('first instalment')
    expect(vnd.getCell(4).numFmt).toBe('#,##0')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes every loan with principal and interest apart, closed ones included', async () => {
    const s = await setup()
    await seedLoans(s.userId)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const loans = sheet(await buildFullWorkbook(ctx), 'Loans')

    // Header plus both loans — the closed one included.
    expect(loans.actualRowCount).toBe(3)

    const bank = rowBy(loans, 1, 'Sacombank')
    expect(bank.getCell(2).value).toBe(1_000_000)
    expect(bank.getCell(3).value).toBe(80_000)
    // Interest is reported apart from the principal and pays nothing down:
    // 1,000,000 − 80,000, never − 90,000.
    expect(bank.getCell(4).value).toBe(10_000)
    expect(bank.getCell(5).value).toBe(920_000)
    expect(bank.getCell(6).value).toBe('VND')
    // The stored rate, unscaled, with its unit in the header — 0.07125 would
    // mean a percentage cell had divided it by 100.
    expect(bank.getCell(7).value).toBe(7.125)
    expect(bank.getCell(7).numFmt).toBe('0.000')
    expect(bank.getCell(8).value).toBe('Monthly')
    expect(bank.getCell(9).value).toBe(90_000)
    expect(bank.getCell(10).value).toEqual(new Date(Date.UTC(2026, 0, 1)))
    // Advanced by exactly one interval when the instalment was recorded.
    expect(bank.getCell(11).value).toEqual(new Date(Date.UTC(2026, 3, 1)))
    expect(bank.getCell(12).value).toBe(12)
    expect(bank.getCell(13).value).toBe('Active')
    expect(bank.getCell(14).value).toBe('car loan')
    expect(bank.getCell(2).numFmt).toBe('#,##0')
    expect(bank.getCell(10).numFmt).toBe('yyyy-mm-dd')

    const family = rowBy(loans, 1, 'Family')
    expect(family.getCell(2).value).toBe(200)
    expect(family.getCell(3).value).toBe(40)
    expect(family.getCell(4).value).toBe(10)
    // NOT zeroed by closing the loan: the agreement is finished, the history
    // stands, and only Net Worth stops counting it.
    expect(family.getCell(5).value).toBe(160)
    // An interest-free loan from family is a real loan, and 0 is a rate.
    expect(family.getCell(7).value).toBe(0)
    expect(family.getCell(13).value).toBe('Closed')
    expect(family.getCell(14).value).toBe('')
    // Cents, in a workbook whose display currency is VND.
    expect(family.getCell(5).numFmt).toBe('#,##0.00')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lists every loan instalment in its parent loan currency, split three ways', async () => {
    const s = await setup()
    await seedLoans(s.userId)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const payments = sheet(await buildFullWorkbook(ctx), 'Loan Payments')

    // Header plus both instalments, oldest first — including the one against
    // the loan that was later closed.
    expect(payments.actualRowCount).toBe(3)
    expect(firstColumn(payments)).toEqual([
      new Date(Date.UTC(2026, 2, 1)),
      new Date(Date.UTC(2026, 2, 2)),
    ])

    const vnd = payments.getRow(2)
    expect(vnd.getCell(2).value).toBe('Sacombank')
    expect(vnd.getCell(3).value).toBe(90_000)
    expect(vnd.getCell(4).value).toBe(80_000)
    expect(vnd.getCell(5).value).toBe(10_000)
    expect(vnd.getCell(6).value).toBe('VND')
    expect(vnd.getCell(7).value).toBe('March instalment')
    // An instalment has no currency of its own — it inherits the loan's, and
    // all three money columns follow the PARENT.
    expect(vnd.getCell(3).numFmt).toBe('#,##0')
    expect(vnd.getCell(4).numFmt).toBe('#,##0')
    expect(vnd.getCell(5).numFmt).toBe('#,##0')
    expect(vnd.getCell(1).numFmt).toBe('yyyy-mm-dd')

    const usd = payments.getRow(3)
    expect(usd.getCell(2).value).toBe('Family')
    expect(usd.getCell(3).value).toBe(50)
    expect(usd.getCell(4).value).toBe(40)
    expect(usd.getCell(5).value).toBe(10)
    expect(usd.getCell(6).value).toBe('USD')
    expect(usd.getCell(3).numFmt).toBe('#,##0.00')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes every reminder with its occurrence tally, paused ones included', async () => {
    const s = await setup()
    await seedReminders(s.userId, s)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const reminders = sheet(await buildFullWorkbook(ctx), 'Reminders')

    // Header plus both reminders, the paused one included.
    expect(reminders.actualRowCount).toBe(3)

    const rent = rowBy(reminders, 1, 'Rent')
    // "Bill", not "Expense": nothing here has been recorded yet.
    expect(rent.getCell(2).value).toBe('Bill')
    expect(rent.getCell(3).value).toBe(5_000_000)
    expect(rent.getCell(4).value).toBe('VND')
    expect(rent.getCell(5).value).toBe('Monthly')
    // `startDate` is the instant of LOCAL midnight (17:00Z the day before in
    // Asia/Ho_Chi_Minh), so the cell has to read back as the day the user
    // picked — the bare stored instant would show 28 February.
    expect(rent.getCell(6).value).toEqual(new Date(Date.UTC(2026, 2, 1)))
    expect(rent.getCell(6).numFmt).toBe('yyyy-mm-dd')
    expect(rent.getCell(7).value).toBe('Yes')
    // One occurrence still pending, one dismissed, none acknowledged.
    expect(rent.getCell(8).value).toBe(1)
    expect(rent.getCell(9).value).toBe(0)
    expect(rent.getCell(10).value).toBe(1)
    expect(rent.getCell(11).value).toBe('Food')
    expect(rent.getCell(12).value).toBe('Wallet')
    expect(rent.getCell(13).value).toBe('landlord transfers')
    expect(rent.getCell(3).numFmt).toBe('#,##0')

    const passport = rowBy(reminders, 1, 'Passport renewal')
    expect(passport.getCell(5).value).toBe('One time')
    expect(passport.getCell(6).value).toEqual(new Date(Date.UTC(2026, 2, 10)))
    // Paused, and still on the sheet with everything it produced.
    expect(passport.getCell(7).value).toBe('No')
    expect(passport.getCell(8).value).toBe(0)
    expect(passport.getCell(9).value).toBe(1)
    expect(passport.getCell(10).value).toBe(0)
    // Neither a category nor an account: blank, not a guess.
    expect(passport.getCell(11).value).toBe('')
    expect(passport.getCell(12).value).toBe('')
    // Cents, in a workbook whose display currency is VND.
    expect(passport.getCell(3).numFmt).toBe('#,##0.00')

    // The export materialized nothing of its own: the tallies count the rows
    // the page's read created, and building the workbook added none.
    expect(await prisma.reminderOccurrence.count({ where: { userId: s.userId } })).toBe(3)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fills all six planning sheets even when no usable rate exists', async () => {
    const s = await setup()
    // A USD balance, so the Accounts and Summary sheets genuinely HAVE
    // something to convert and therefore something to leave blank.
    await seedTransaction(s.userId, {
      accountId: s.usdAccountId,
      type: 'CASH_IN',
      amount: 100,
      currency: 'USD',
      date: new Date('2026-03-10T05:00:00Z'),
    })
    await seedSavingsGoals(s.userId)
    await seedDebts(s.userId)
    await seedLoans(s.userId)
    await seedReminders(s.userId, s)

    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: failingFxProvider,
    })
    expect(ctx.fx).toBeNull()

    const workbook = await buildFullWorkbook(ctx)

    // Every planning sheet is complete...
    expect(sheet(workbook, 'Savings Goals').actualRowCount).toBe(3)
    expect(sheet(workbook, 'Debts').actualRowCount).toBe(4)
    expect(sheet(workbook, 'Debt Payments').actualRowCount).toBe(5)
    expect(sheet(workbook, 'Loans').actualRowCount).toBe(3)
    expect(sheet(workbook, 'Loan Payments').actualRowCount).toBe(3)
    expect(sheet(workbook, 'Reminders').actualRowCount).toBe(3)
    // ...with every figure on it intact, because not one of them is converted.
    expect(rowBy(sheet(workbook, 'Savings Goals'), 1, 'New laptop').getCell(3).value).toBe(1_200)
    expect(rowBy(sheet(workbook, 'Debts'), 2, 'An').getCell(5).value).toBe(500_000)
    expect(rowBy(sheet(workbook, 'Debt Payments'), 2, 'Binh').getCell(4).value).toBe(100)
    expect(rowBy(sheet(workbook, 'Loans'), 1, 'Sacombank').getCell(5).value).toBe(920_000)
    expect(rowBy(sheet(workbook, 'Loan Payments'), 2, 'Family').getCell(3).value).toBe(50)
    expect(rowBy(sheet(workbook, 'Reminders'), 1, 'Rent').getCell(3).value).toBe(5_000_000)

    // Only the CONVERTED cells are blank, and the sheet says why.
    const summary = sheet(workbook, 'Summary')
    expect(String(labelledRow(summary, 'FX rate').getCell(2).value)).toContain('unavailable')
    expect(labelledRow(summary, 'Total account balance').getCell(2).value).toBeNull()
    expect(labelledRow(summary, 'Net worth').getCell(2).value).toBeNull()
    expect(labelledRow(sheet(workbook, 'Accounts'), 'Dollar savings').getCell(7).value).toBeNull()

    // And nothing went looking for a rate of its own.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
