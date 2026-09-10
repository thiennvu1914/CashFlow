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
  expectNoEmptyStrings,
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

/**
 * The workbook this fixture produced BEFORE Task 4 changed what the Debts and
 * Loans sheets fetch: captured from the pre-change build and pasted here
 * verbatim, one line per row. If a single cell, number format or row order
 * moves, this is the case that says which one.
 *
 * `Transfers r1` and `Budgets r1` are header-only here — this fixture seeds no
 * transfer and no budget, so those two sheets have nothing to add to a golden
 * that is already ~40 lines of every other sheet's data rows. Their own cell
 * contract is covered elsewhere, per row and per format: transfers by 'lists
 * transfers with both legs, their currencies and the rate used' and the
 * Summary-count case above, budgets by 'writes each budget in its own
 * currency, from historical rates and no current one' and the
 * archived-category and per-month-scan cases below. Adding a row of each here
 * would duplicate that coverage and double the Summary-sheet figures (account
 * balance, net worth, monthly income/expense) this golden would then also have
 * to carry by hand.
 */
const EXPECTED_WORKBOOK_CELLS: string[] = [
  'Summary r1: Metric | Value | Note',
  'Summary r2: Generated at | 2026-03-15T12:00:00.000Z [yyyy-mm-dd hh:mm] | ',
  'Summary r3: Timezone | Asia/Ho_Chi_Minh | ',
  'Summary r4: Display currency | VND | ',
  'Summary r5: FX rate | <volatile> | ',
  'Summary r6: Total account balance | 0 [#,##0] | ',
  'Summary r7: Net worth | -420000 [#,##0] | ',
  'Summary r8: Monthly income | 0 [#,##0] | Current local month, at each row’s own rate',
  'Summary r9: Monthly expense | 0 [#,##0] | Current local month, at each row’s own rate',
  'Summary r10: Monthly net income | 0 [#,##0] | Current local month, at each row’s own rate',
  'Summary r11: Active accounts | 2 | ',
  'Summary r12: Archived accounts | 0 | ',
  'Summary r13: Transactions | 1 | ',
  'Summary r14: Transfers | 0 | ',
  'Accounts r1: Name | Type | Currency | Status | Initial balance | Current balance | Current balance (VND) | Created',
  'Accounts r2: Wallet | Cash | VND | ACTIVE | 0 [#,##0] | 0 [#,##0] | 0 [#,##0] | <volatile> [yyyy-mm-dd]',
  'Accounts r3: Dollar savings | Cash | USD | ACTIVE | 0 [#,##0.00] | 0 [#,##0.00] | 0 [#,##0] | <volatile> [yyyy-mm-dd]',
  'Transactions r1: Transaction id | Date | Type | Category | Account | Amount | Currency | Amount (VND, historical rate) | VND per USD at entry | FX source | FX effective (UTC day) | FX fetched (local) | Note',
  'Transactions r2: <volatile> | 2026-03-10T12:00:00.000Z [yyyy-mm-dd hh:mm] | CASH_IN |  | Dollar savings | 100 [#,##0.00] | USD | 2500000 [#,##0] | 25000 [#,##0.000000] | export-seeded | 2026-03-10T00:00:00.000Z [yyyy-mm-dd] | 2026-03-10T12:00:00.000Z [yyyy-mm-dd hh:mm] | ',
  'Transfers r1: Date | From account | To account | From amount | From currency | To amount | To currency | Rate used | Note',
  'Budgets r1: Year | Month | Scope | Category | Amount | Currency | Spent | Remaining | Used % | Status | Created',
  'Savings Goals r1: Name | Target | Progress | Remaining | Progress % | Currency | Deadline | Status | Note | Created',
  'Savings Goals r2: Emergency fund | 10000000 [#,##0] | 2500000 [#,##0] | 7500000 [#,##0] | 0.25 [0%] | VND | 2026-12-31T00:00:00.000Z [yyyy-mm-dd] | In progress | three months of expenses | <volatile> [yyyy-mm-dd hh:mm]',
  'Savings Goals r3: New laptop | 1000 [#,##0.00] | 1200 [#,##0.00] | 0 [#,##0.00] | 1.2 [0%] | USD |  [yyyy-mm-dd] | Archived |  | <volatile> [yyyy-mm-dd hh:mm]',
  'Debts r1: Direction | Person | Original | Paid | Outstanding | Currency | Due date | Status | Description | Notes | Created',
  'Debts r2: Receivable | An | 1000000 [#,##0] | 500000 [#,##0] | 500000 [#,##0] | VND | 2026-04-30T00:00:00.000Z [yyyy-mm-dd] | Partly paid | lent for the deposit | paying in instalments | <volatile> [yyyy-mm-dd hh:mm]',
  'Debts r3: Receivable | Chi | 100000 [#,##0] | 100000 [#,##0] | 0 [#,##0] | VND | 2026-03-01T00:00:00.000Z [yyyy-mm-dd] | Paid |  |  | <volatile> [yyyy-mm-dd hh:mm]',
  'Debts r4: Payable | Binh | 400 [#,##0.00] | 100 [#,##0.00] | 300 [#,##0.00] | USD |  [yyyy-mm-dd] | Written off |  |  | <volatile> [yyyy-mm-dd hh:mm]',
  'Debt Payments r1: Date | Debt | Direction | Amount | Currency | Note',
  'Debt Payments r2: 2026-03-04T00:00:00.000Z [yyyy-mm-dd] | Binh | Payable | 100 [#,##0.00] | USD | ',
  'Debt Payments r3: 2026-03-05T00:00:00.000Z [yyyy-mm-dd] | An | Receivable | 300000 [#,##0] | VND | first instalment',
  'Debt Payments r4: 2026-03-06T00:00:00.000Z [yyyy-mm-dd] | An | Receivable | 200000 [#,##0] | VND | ',
  'Debt Payments r5: 2026-03-07T00:00:00.000Z [yyyy-mm-dd] | Chi | Receivable | 100000 [#,##0] | VND | ',
  'Loans r1: Lender | Principal | Principal paid | Interest paid | Outstanding principal | Currency | Interest rate (%) | Frequency | Scheduled payment | Start date | Next due date | Term (months) | Status | Notes | Created',
  'Loans r2: Sacombank | 1000000 [#,##0] | 80000 [#,##0] | 10000 [#,##0] | 920000 [#,##0] | VND | 7.125 [0.000] | Monthly | 90000 [#,##0] | 2026-01-01T00:00:00.000Z [yyyy-mm-dd] | 2026-04-01T00:00:00.000Z [yyyy-mm-dd] | 12 | Active | car loan | <volatile> [yyyy-mm-dd hh:mm]',
  'Loans r3: Family | 200 [#,##0.00] | 40 [#,##0.00] | 10 [#,##0.00] | 160 [#,##0.00] | USD | 0 [0.000] | Monthly | 50 [#,##0.00] | 2026-02-01T00:00:00.000Z [yyyy-mm-dd] | 2026-04-01T00:00:00.000Z [yyyy-mm-dd] | 6 | Closed |  | <volatile> [yyyy-mm-dd hh:mm]',
  'Loan Payments r1: Date | Loan | Total | Principal | Interest | Currency | Note',
  'Loan Payments r2: 2026-03-01T00:00:00.000Z [yyyy-mm-dd] | Sacombank | 90000 [#,##0] | 80000 [#,##0] | 10000 [#,##0] | VND | March instalment',
  'Loan Payments r3: 2026-03-02T00:00:00.000Z [yyyy-mm-dd] | Family | 50 [#,##0.00] | 40 [#,##0.00] | 10 [#,##0.00] | USD | ',
  'Reminders r1: Title | Type | Expected amount | Currency | Frequency | Start date | Active | Pending | Acknowledged | Dismissed | Category | Account | Note | Created | Timezone',
  'Reminders r2: Rent | Bill | 5000000 [#,##0] | VND | Monthly | 2026-03-01T00:00:00.000Z [yyyy-mm-dd] | Yes | 1 | 0 | 1 | Food | Wallet | landlord transfers | <volatile> [yyyy-mm-dd hh:mm] | Asia/Ho_Chi_Minh',
  'Reminders r3: Passport renewal | Bill | 200 [#,##0.00] | USD | One time | 2026-03-10T00:00:00.000Z [yyyy-mm-dd] | No | 0 | 1 | 0 |  |  |  | <volatile> [yyyy-mm-dd hh:mm] | Asia/Ho_Chi_Minh',
]

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

    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
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
    // An OVERALL budget has no category — blank, never an empty string, which
    // Excel would render as a shared-string index.
    expect(overallRow.getCell(4).value).toBeNull()
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

    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
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

    const workbook = await buildFullWorkbook(ctx)
    const goals = sheet(workbook, 'Savings Goals')

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
    // No note: blank, never an empty string, which Excel would render as a
    // shared-string index.
    expect(laptop.getCell(9).value).toBeNull()
    // Cents, in a workbook whose display currency is VND.
    expect(laptop.getCell(2).numFmt).toBe('#,##0.00')
    expect(laptop.getCell(4).numFmt).toBe('#,##0.00')

    expect(fetchSpy).not.toHaveBeenCalled()
    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
  })

  it('writes every debt with its derived outstanding, written-off ones included', async () => {
    const s = await setup()
    await seedDebts(s.userId)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const workbook = await buildFullWorkbook(ctx)
    const debts = sheet(workbook, 'Debts')

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
    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
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

    const workbook = await buildFullWorkbook(ctx)
    const loans = sheet(workbook, 'Loans')

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
    // No notes: blank, never an empty string, which Excel would render as a
    // shared-string index.
    expect(family.getCell(14).value).toBeNull()
    // Cents, in a workbook whose display currency is VND.
    expect(family.getCell(5).numFmt).toBe('#,##0.00')

    expect(fetchSpy).not.toHaveBeenCalled()
    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
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

    const workbook = await buildFullWorkbook(ctx)
    const reminders = sheet(workbook, 'Reminders')

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
    // The zone the schedule is anchored to, written verbatim: `Start date`
    // beside it is the same instant read in the *viewer's* zone, and only this
    // column says which zone the reminder actually recurs in (ruling R6-22).
    expect(rent.getCell(15).value).toBe(TEST_TIMEZONE)

    const passport = rowBy(reminders, 1, 'Passport renewal')
    expect(passport.getCell(5).value).toBe('One time')
    expect(passport.getCell(6).value).toEqual(new Date(Date.UTC(2026, 2, 10)))
    // Paused, and still on the sheet with everything it produced.
    expect(passport.getCell(7).value).toBe('No')
    expect(passport.getCell(8).value).toBe(0)
    expect(passport.getCell(9).value).toBe(1)
    expect(passport.getCell(10).value).toBe(0)
    // Neither a category nor an account: blank, not a guess — and a truly empty
    // cell, never an empty string, which Excel renders as a shared-string index.
    expect(passport.getCell(11).value).toBeNull()
    expect(passport.getCell(12).value).toBeNull()
    // Cents, in a workbook whose display currency is VND.
    expect(passport.getCell(3).numFmt).toBe('#,##0.00')

    // The export materialized nothing of its own: the tallies count the rows
    // the page's read created, and building the workbook added none.
    expect(await prisma.reminderOccurrence.count({ where: { userId: s.userId } })).toBe(3)

    expect(fetchSpy).not.toHaveBeenCalled()
    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
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
    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
  })

  /**
   * Every cell of the whole workbook, as a literal (Phase 8, Task 4).
   *
   * The other cases here each check one sheet's rules. This one is the blunt
   * instrument they cannot be: the eleven sheets' every row, every cell value
   * and every number format, written out. It exists because Task 4 changed what
   * the Debts and Loans sheets *fetch* (their payment history is no longer
   * joined — finding B-7), and the only honest way to claim the workbook did
   * not change is to compare the whole of it against what it produced before.
   *
   * Three families of cell are masked, because they are clock or id readings
   * rather than fixture facts: any column headed `Created` (the row's own
   * `createdAt`), the `Transaction id` column (a cuid), and the Summary sheet's
   * FX-rate description (`fakeFxProvider` stamps it with `Date.now()`).
   * Everything else — including every derived total, status, date and currency
   * format — is asserted literally, with dates written as ISO instants so the
   * golden does not depend on the host's own zone.
   */
  function dumpWorkbook(workbook: ExcelJS.Workbook): string[] {
    const lines: string[] = []
    for (const worksheet of workbook.worksheets) {
      // The header row decides which columns are clock readings, so the mask
      // follows the sheet's own contract rather than a column index.
      const headers: string[] = []
      worksheet.getRow(1).eachCell((cell, column) => {
        headers[column] = String(cell.value ?? '')
      })
      worksheet.eachRow((row, index) => {
        const cells: string[] = []
        row.eachCell({ includeEmpty: true }, (cell, column) => {
          const masked =
            index > 1 &&
            (headers[column] === 'Created' ||
              headers[column] === 'Transaction id' ||
              (worksheet.name === 'Summary' && column === 2 && row.getCell(1).value === 'FX rate'))
          const value = masked ? '<volatile>' : cell.value
          const format = cell.numFmt ? ` [${cell.numFmt}]` : ''
          // Dates as ISO instants: `String(date)` is the *host's* wall clock, so
          // a golden built here would read differently under `TZ=UTC` in CI.
          const text =
            value === null || value === undefined
              ? ''
              : value instanceof Date
                ? value.toISOString()
                : String(value)
          cells.push(`${text}${format}`)
        })
        lines.push(`${worksheet.name} r${index}: ${cells.join(' | ')}`)
      })
    }
    return lines
  }

  it('produces the same workbook, cell for cell, as before the payload changes', async () => {
    const s = await setup()
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
      providerOverride: fakeFxProvider(),
    })

    const workbook = await buildFullWorkbook(ctx)

    expect(dumpWorkbook(workbook)).toEqual(EXPECTED_WORKBOOK_CELLS)
  })

  /**
   * A payment row crosses the wire once per workbook (Phase 8, Task 4 —
   * finding B-7).
   *
   * The full export used to read every `DebtPayment` twice: once joined onto
   * the Debts sheet's `getDebtsWithOutstanding` (which renders only `Paid` and
   * `Outstanding`, so the rows were dropped), and once by the Debt Payments
   * sheet, which is the sheet that actually lists them. Same for loans, and the
   * Summary sheet's Net Worth read made it a third join.
   *
   * The two payment sheets stay exactly as they are — they are the one legitimate
   * reader of the history — so the assertion is that the *other* reads no longer
   * join it: two `Debt` reads and two `Loan` reads per workbook (the Summary
   * sheet's Net Worth and the record sheet itself), none of them with an
   * include, and one payment `findMany` each.
   */
  it('fetches each payment row once for the whole workbook', async () => {
    const s = await setup()
    await seedDebts(s.userId)
    await seedLoans(s.userId)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })
    const debtFindMany = vi.spyOn(prisma.debt, 'findMany')
    const loanFindMany = vi.spyOn(prisma.loan, 'findMany')
    const debtPaymentFindMany = vi.spyOn(prisma.debtPayment, 'findMany')
    const loanPaymentFindMany = vi.spyOn(prisma.loanPayment, 'findMany')

    await buildFullWorkbook(ctx)

    // Summary (Net Worth) and the Debts sheet: two reads of the debt table,
    // neither of them carrying the history.
    expect(debtFindMany).toHaveBeenCalledTimes(2)
    expect(debtFindMany.mock.calls.every((call) => call[0]?.include === undefined)).toBe(true)
    expect(loanFindMany).toHaveBeenCalledTimes(2)
    expect(loanFindMany.mock.calls.every((call) => call[0]?.include === undefined)).toBe(true)
    // And exactly one read each of the payment tables — the sheets that list
    // them.
    expect(debtPaymentFindMany).toHaveBeenCalledTimes(1)
    expect(loanPaymentFindMany).toHaveBeenCalledTimes(1)
  })

  /**
   * A record on every sheet with each of its optional text fields left unset —
   * the shape that used to fill a workbook with the literal string "4".
   *
   * ExcelJS stores `''` as a shared string, and Excel renders an *empty*
   * shared-string item as its own index, so one absent note anywhere put a
   * stray number in every absent-text cell of the file. Nothing on these rows
   * is exotic: an OVERALL budget, a debt with no description, an interest-only
   * instalment. The point is that all of them are absent at once, so a single
   * builder still writing `''` fails the whole-file check below.
   */
  async function seedSparseOptionalText(s: Awaited<ReturnType<typeof setup>>) {
    const transaction = await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      // Neither a category nor a note — two optional text columns at once.
      categoryId: null,
      amount: 12_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    await prisma.transfer.create({
      data: {
        userId: s.userId,
        fromAccountId: s.vndAccountId,
        toAccountId: s.usdAccountId,
        fromAmount: new Prisma.Decimal(26_000),
        toAmount: new Prisma.Decimal(1),
        exchangeRateUsed: new Prisma.Decimal(1).div(26_000),
        date: new Date('2026-03-11T05:00:00Z'),
      },
    })
    // OVERALL, so the Category column has nothing to say.
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
    // No note, and nothing saved yet: the two zero cells of assertion 8.
    const goal = await createSavingsGoal(s.userId, {
      name: 'Untouched fund',
      targetAmount: 5_000_000,
      currency: 'VND',
      currentProgress: 0,
    })
    // No description, no notes, no due date.
    const debt = await createDebt(s.userId, {
      direction: 'RECEIVABLE',
      person: 'Duc',
      originalAmount: 500_000,
      currency: 'VND',
    })
    // And a repayment with no note of its own.
    await recordDebtPayment(s.userId, debt.id, { amount: 50_000, date: '2026-03-06' })
    // No notes.
    const loan = await createLoan(s.userId, {
      lender: 'Agribank',
      principal: 1_000_000,
      currency: 'VND',
      interestRate: 6.5,
      startDate: '2026-01-01',
      termMonths: 12,
      paymentFrequency: 'MONTHLY',
      scheduledPaymentAmount: 90_000,
      nextDueDate: '2026-03-01',
    })
    // An interest-only instalment and a principal-only one, both note-free:
    // a zero here is a fact about the split and must stay a numeric 0.
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 5_000,
      principalAmount: 0,
      interestAmount: 5_000,
      paymentDate: '2026-03-01',
    })
    await recordLoanPayment(s.userId, loan.id, {
      totalAmount: 80_000,
      principalAmount: 80_000,
      interestAmount: 0,
      paymentDate: '2026-03-02',
    })
    // No category, no account, no note.
    const reminder = await createReminder(s.userId, TEST_TIMEZONE, {
      title: 'Water bill',
      type: 'EXPENSE',
      expectedAmount: 300_000,
      currency: 'VND',
      frequency: 'MONTHLY',
      interval: 1,
      startDate: '2026-03-01',
    })
    return { transaction, goal, debt, loan, reminder }
  }

  it('leaves an absent optional text blank instead of an empty shared string', async () => {
    const s = await setup()
    const seeded = await seedSparseOptionalText(s)
    const ctx = await makeExportContext(s.userId, {
      now: EXPORT_NOW,
      providerOverride: fakeFxProvider(),
    })

    const workbook = await buildFullWorkbook(ctx)

    // (1) The Summary's third column is a note only some rows have.
    const summary = sheet(workbook, 'Summary')
    expect(labelledRow(summary, 'Timezone').getCell(3).value).toBeNull()
    expect(labelledRow(summary, 'Active accounts').getCell(3).value).toBeNull()
    // A rate WAS available, so the two current figures carry no "unavailable"
    // note either — and the cell is empty rather than an empty string.
    expect(labelledRow(summary, 'Total account balance').getCell(3).value).toBeNull()

    // (2) A transaction with no category and no note.
    const transaction = rowBy(sheet(workbook, 'Transactions'), 1, seeded.transaction.id)
    expect(transaction.getCell(4).value).toBeNull()
    expect(transaction.getCell(13).value).toBeNull()

    // A transfer with no note.
    expect(sheet(workbook, 'Transfers').getRow(2).getCell(9).value).toBeNull()

    // (3) An OVERALL budget has no category.
    const budget = rowBy(sheet(workbook, 'Budgets'), 3, 'OVERALL')
    expect(budget.getCell(4).value).toBeNull()

    // (4) A savings goal with no note.
    const goals = sheet(workbook, 'Savings Goals')
    const goal = rowBy(goals, 1, 'Untouched fund')
    expect(goal.getCell(9).value).toBeNull()

    // (5) A debt with neither a description nor notes.
    const debt = rowBy(sheet(workbook, 'Debts'), 2, 'Duc')
    expect(debt.getCell(9).value).toBeNull()
    expect(debt.getCell(10).value).toBeNull()
    // And its repayment, which carries no note.
    expect(rowBy(sheet(workbook, 'Debt Payments'), 2, 'Duc').getCell(6).value).toBeNull()

    // (6) A loan with no notes.
    const loans = sheet(workbook, 'Loans')
    expect(rowBy(loans, 1, 'Agribank').getCell(14).value).toBeNull()

    // (7) A reminder with no category, no account and no note.
    const reminder = rowBy(sheet(workbook, 'Reminders'), 1, 'Water bill')
    expect(reminder.getCell(11).value).toBeNull()
    expect(reminder.getCell(12).value).toBeNull()
    expect(reminder.getCell(13).value).toBeNull()

    // (8) A numeric zero is a fact, and stays a number — never blanked by the
    // same change that blanked the absent text.
    const archived = labelledRow(summary, 'Archived accounts').getCell(2)
    expect(archived.value).toBe(0)
    expect(typeof archived.value).toBe('number')
    const instalments = sheet(workbook, 'Loan Payments')
    const interestOnly = rowBy(instalments, 3, 5_000)
    // Nothing paid down, and the split says so with a 0 rather than a blank.
    expect(interestOnly.getCell(4).value).toBe(0)
    expect(typeof interestOnly.getCell(4).value).toBe('number')
    expect(interestOnly.getCell(7).value).toBeNull()
    const principalOnly = rowBy(instalments, 3, 80_000)
    expect(principalOnly.getCell(5).value).toBe(0)
    expect(typeof principalOnly.getCell(5).value).toBe('number')
    // Nothing saved yet: 0 of the target, and 0 % of it.
    expect(goal.getCell(3).value).toBe(0)
    expect(typeof goal.getCell(3).value).toBe('number')
    expect(goal.getCell(5).value).toBe(0)
    expect(typeof goal.getCell(5).value).toBe('number')

    // And, in the bytes Excel actually opens, not one empty shared string.
    await expectNoEmptyStrings(await workbook.xlsx.writeBuffer())
  })
})
