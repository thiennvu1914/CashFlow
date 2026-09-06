import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type ExcelJS from 'exceljs'
import { resolveReportRange } from '@/lib/reports/report-range'
import { buildExportContext } from './export-context'
import { buildFilteredWorkbook } from './filtered-export'
import {
  TEST_TIMEZONE,
  cleanupExportUsers,
  createExportUser,
  fakeFxProvider,
  seedTransaction,
} from './test-fixtures'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * The point of this suite is that the filtered workbook covers *exactly* the
 * window the Reports page resolved, boundary instants included: the range is
 * produced by the same `resolveReportRange` the page calls, never by a second
 * interpretation of the query string written for the export.
 */

/** The first row whose column A is `label` — assertions locate a figure by what
 *  it is called, not by a row number a later edit would silently shift. */
function labelledRow(sheet: ExcelJS.Worksheet, label: string): ExcelJS.Row {
  let found: ExcelJS.Row | undefined
  sheet.eachRow((row) => {
    if (found === undefined && row.getCell(1).value === label) found = row
  })
  if (!found) throw new Error(`No row labelled ${JSON.stringify(label)} in ${sheet.name}`)
  return found
}

describe('buildFilteredWorkbook', () => {
  const createdUserIds: string[] = []

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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

  it('includes only transactions inside the exact custom range it is given', async () => {
    const s = await setup()
    // 10 Mar 12:00 +07:00 — comfortably inside.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 1_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    // 31 Mar 23:59 +07:00 — the last local minute of the range.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 2_000,
      date: new Date('2026-03-31T16:59:00Z'),
    })
    // 1 Apr 00:00 +07:00 — the exclusive bound itself, so outside.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 4_000,
      date: new Date('2026-03-31T17:00:00Z'),
    })
    // 28 Feb 23:59 +07:00 — the minute before the range opens.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 8_000,
      date: new Date('2026-02-28T16:59:00Z'),
    })

    const range = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TEST_TIMEZONE,
    )
    const ctx = await buildExportContext(s.userId, { providerOverride: fakeFxProvider() })
    const workbook = await buildFilteredWorkbook(ctx, range)

    const transactions = workbook.getWorksheet('Transactions')
    if (!transactions) throw new Error('no Transactions sheet')
    // Header row plus exactly the two rows inside the window. `actualRowCount`
    // counts rows that actually carry values, so a stray blank cannot pad it.
    expect(transactions.actualRowCount).toBe(3)

    const summary = workbook.getWorksheet('Summary')
    if (!summary) throw new Error('no Summary sheet')
    expect(labelledRow(summary, 'Expense').getCell(2).value).toBe(3_000)
    expect(labelledRow(summary, 'Income').getCell(2).value).toBe(0)
    expect(labelledRow(summary, 'Net Income').getCell(2).value).toBe(-3_000)
  })

  it('writes the date as the user local wall clock, not the stored UTC instant', async () => {
    const s = await setup()
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 1_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })

    const range = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TEST_TIMEZONE,
    )
    const ctx = await buildExportContext(s.userId, { providerOverride: fakeFxProvider() })
    const workbook = await buildFilteredWorkbook(ctx, range)
    const transactions = workbook.getWorksheet('Transactions')
    if (!transactions) throw new Error('no Transactions sheet')

    // 05:00Z is 12:00 in Asia/Ho_Chi_Minh. Excel has no timezone, so the cell
    // carries a Date whose UTC components ARE the local wall clock — which is
    // what the spreadsheet then displays.
    expect(transactions.getRow(2).getCell(2).value).toEqual(new Date(Date.UTC(2026, 2, 10, 12, 0)))
  })

  it('describes the range the way the page does, with an inclusive end date', async () => {
    const s = await setup()
    const range = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TEST_TIMEZONE,
    )
    const ctx = await buildExportContext(s.userId, { providerOverride: fakeFxProvider() })
    const summary = (await buildFilteredWorkbook(ctx, range)).getWorksheet('Summary')
    if (!summary) throw new Error('no Summary sheet')

    expect(labelledRow(summary, 'Range from').getCell(2).value).toBe('2026-03-01')
    // The inclusive last day, never the exclusive bound (which is 1 April).
    expect(labelledRow(summary, 'Range to').getCell(2).value).toBe('2026-03-31')
    expect(labelledRow(summary, 'Range end (UTC, exclusive)').getCell(2).value).toBe(
      '2026-03-31T17:00:00.000Z',
    )
    expect(labelledRow(summary, 'Timezone').getCell(2).value).toBe(TEST_TIMEZONE)
    expect(labelledRow(summary, 'Display currency').getCell(2).value).toBe('VND')
  })

  it('breaks the window down by category and by account', async () => {
    const s = await setup()
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.expenseCategoryId,
      amount: 3_000,
      date: new Date('2026-03-10T05:00:00Z'),
    })
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      categoryId: s.incomeCategoryId,
      type: 'INCOME',
      amount: 10_000,
      date: new Date('2026-03-11T05:00:00Z'),
    })

    const range = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TEST_TIMEZONE,
    )
    const ctx = await buildExportContext(s.userId, { providerOverride: fakeFxProvider() })
    const summary = (await buildFilteredWorkbook(ctx, range)).getWorksheet('Summary')
    if (!summary) throw new Error('no Summary sheet')

    // Expenses only in the category breakdown — an income row has no place in
    // a spending breakdown.
    expect(labelledRow(summary, 'Food').getCell(2).value).toBe(3_000)
    // Per account: income, expense and net income, never one unsigned total.
    const account = labelledRow(summary, 'Wallet')
    expect(account.getCell(2).value).toBe(10_000)
    expect(account.getCell(3).value).toBe(3_000)
    expect(account.getCell(4).value).toBe(7_000)
  })

  it('says on the sheet why the totals exclude non-activity rows', async () => {
    const s = await setup()
    // A CASH_IN is a balance movement, not income: it shows up on the
    // Transactions sheet but in none of the three totals.
    await seedTransaction(s.userId, {
      accountId: s.vndAccountId,
      type: 'CASH_IN',
      amount: 500,
      date: new Date('2026-03-10T05:00:00Z'),
    })

    const range = resolveReportRange(
      { period: 'custom', from: '2026-03-01', to: '2026-03-31' },
      TEST_TIMEZONE,
    )
    const ctx = await buildExportContext(s.userId, { providerOverride: fakeFxProvider() })
    const workbook = await buildFilteredWorkbook(ctx, range)
    const summary = workbook.getWorksheet('Summary')
    const transactions = workbook.getWorksheet('Transactions')
    if (!summary || !transactions) throw new Error('missing sheet')

    // The row is in the ledger...
    expect(transactions.actualRowCount).toBe(2)
    // ...and in none of the totals, which the note next to them explains.
    expect(labelledRow(summary, 'Income').getCell(2).value).toBe(0)
    const note = labelledRow(summary, 'Income').getCell(3).value
    expect(note).toBe(
      'Income and Expense count INCOME/EXPENSE rows only; the Transactions sheet lists all types.',
    )
    expect(labelledRow(summary, 'Expense').getCell(3).value).toBe(note)
    expect(labelledRow(summary, 'Net Income').getCell(3).value).toBe(note)
  })
})
