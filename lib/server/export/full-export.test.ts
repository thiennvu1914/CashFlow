import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type ExcelJS from 'exceljs'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

import { FULL_EXPORT_SHEET_BUILDERS, buildFullWorkbook } from './sheet-registry'
import {
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

  it('produces Summary, Accounts, Transactions, Transfers and Budgets in registry order', async () => {
    const s = await setup()
    const ctx = await makeExportContext(s.userId, { providerOverride: fakeFxProvider() })

    const workbook = await buildFullWorkbook(ctx)

    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Accounts',
      'Transactions',
      'Transfers',
      'Budgets',
    ])
    // The array is the single source of truth Phase 6 appends to.
    expect(FULL_EXPORT_SHEET_BUILDERS).toHaveLength(5)
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

    for (const name of ['Summary', 'Accounts', 'Transactions', 'Transfers', 'Budgets']) {
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
})
