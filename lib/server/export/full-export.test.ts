import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type ExcelJS from 'exceljs'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { buildExportContext } from './export-context'
import { FULL_EXPORT_SHEET_BUILDERS, buildFullWorkbook } from './sheet-registry'
import {
  cleanupExportUsers,
  createExportUser,
  failingFxProvider,
  fakeFxProvider,
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

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A rate cached by an earlier test in this file would otherwise let the
    // FX-unavailable case quietly find one.
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

  it('produces Summary, Accounts, Transactions and Transfers in registry order', async () => {
    const s = await setup()
    const ctx = await buildExportContext(s.userId, new Date(), fakeFxProvider())

    const workbook = await buildFullWorkbook(ctx)

    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Accounts',
      'Transactions',
      'Transfers',
    ])
    // The array is the single source of truth Phase 5/6 append to.
    expect(FULL_EXPORT_SHEET_BUILDERS).toHaveLength(4)
  })

  it('includes archived accounts, their status, and their history', async () => {
    const s = await setup()
    const archived = await archivedAccountWithHistory(s)
    const ctx = await buildExportContext(s.userId, new Date(), fakeFxProvider())

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
      if (index > 1) notes.push(row.getCell(12).value)
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
    const ctx = await buildExportContext(s.userId, new Date(), fakeFxProvider())

    const workbook = await buildFullWorkbook(ctx)

    // Header row plus 205 data rows — the bounded UI list would have stopped
    // at 200 and the workbook would have looked complete.
    expect(sheet(workbook, 'Transactions').rowCount).toBe(206)
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
    const ctx = await buildExportContext(s.userId, new Date(), fakeFxProvider())

    const transfers = sheet(await buildFullWorkbook(ctx), 'Transfers')

    expect(transfers.rowCount).toBe(2)
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
    await seedTransaction(s.userId, {
      accountId: s.usdAccountId,
      categoryId: s.expenseCategoryId,
      amount: 100,
      currency: 'USD',
      date: new Date('2026-03-10T05:00:00Z'),
      vndPerUsdAtEntry: 25_500,
    })
    const ctx = await buildExportContext(s.userId, new Date(), fakeFxProvider(26_000))
    expect(ctx.fx?.rateDecimal.toNumber()).toBe(26_000)

    const transactions = sheet(await buildFullWorkbook(ctx), 'Transactions')
    const row = transactions.getRow(2)

    // The native amount is untouched...
    expect(row.getCell(5).value).toBe(100)
    expect(row.getCell(6).value).toBe('USD')
    // ...and the display-currency column is 100 × 25,500, the row's own rate —
    // 100 × 26,000 would mean history moved when this morning's rate did.
    expect(row.getCell(7).value).toBe(2_550_000)
    expect(row.getCell(8).value).toBe(25_500)
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

    // No cached rate, a provider that refuses, and `fetch` stubbed to throw:
    // there is no honest number available anywhere.
    const ctx = await buildExportContext(s.userId, new Date(), failingFxProvider)
    expect(ctx.fx).toBeNull()

    const workbook = await buildFullWorkbook(ctx)

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
    const ctx = await buildExportContext(s.userId, new Date(), fakeFxProvider(26_000))

    const summary = sheet(await buildFullWorkbook(ctx), 'Summary')

    expect(labelledRow(summary, 'Timezone').getCell(2).value).toBe('Asia/Ho_Chi_Minh')
    expect(labelledRow(summary, 'Display currency').getCell(2).value).toBe('VND')
    expect(labelledRow(summary, 'Active accounts').getCell(2).value).toBe(2)
    expect(labelledRow(summary, 'Archived accounts').getCell(2).value).toBe(1)
    expect(labelledRow(summary, 'Transactions').getCell(2).value).toBe(3)
    expect(labelledRow(summary, 'Transfers').getCell(2).value).toBe(1)
    // 1,000,000 − 260,000 in the VND wallet, plus 10 USD restated at 26,000.
    expect(labelledRow(summary, 'Total account balance').getCell(2).value).toBe(1_000_000)
    expect(String(labelledRow(summary, 'FX rate').getCell(2).value)).toContain('26000')
  })
})
