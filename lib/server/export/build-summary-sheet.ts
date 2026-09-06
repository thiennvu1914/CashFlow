import type ExcelJS from 'exceljs'
import type { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import { getMonthlyIncomeExpense } from '@/lib/server/services/activity'
import { getCurrentPosition } from '@/lib/server/services/position'
import type { CurrentPosition } from '@/lib/server/services/position'
import {
  DATE_TIME_FMT,
  localDateCell,
  moneyCell,
  moneyFmt,
  optionalMoneyCell,
  writeHeader,
} from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The Summary sheet — the cover page of the full workbook.
 *
 * It answers, in one screen, what the rest of the file is: whose figures, in
 * which currency, computed in which timezone, at which instant, and against
 * which exchange rate. That last line matters most. Two of the figures below —
 * the total balance and net worth — are *current* positions and therefore
 * depend on a live rate; the monthly income and expense figures are *history*
 * and are restated at each row's own snapshot, so they are unaffected by an FX
 * outage and never blank. Anyone reading the workbook can tell which is which
 * from the FX line alone.
 *
 * When no usable rate exists the two current figures are left empty with a note
 * saying why, rather than being filled with a stale or invented number.
 */
export async function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const [position, monthly, accountsByStatus, transactionCount, transferCount] = await Promise.all([
    // Wrapped exactly like `buildExportContext`: a missing rate blanks two
    // cells, it does not fail the download. Anything else is a real fault.
    currentPositionOrNull(ctx),
    // Historical by construction — `getMonthlyIncomeExpense` restates each row
    // at the rate that row snapshotted, so no current rate is involved.
    getMonthlyIncomeExpense(ctx.userId, ctx.timezone, ctx.displayCurrency, ctx.now),
    prisma.financialAccount.groupBy({
      by: ['status'],
      where: { userId: ctx.userId },
      _count: { _all: true },
    }),
    prisma.transaction.count({ where: { userId: ctx.userId } }),
    prisma.transfer.count({ where: { userId: ctx.userId } }),
  ])

  const sheet = workbook.addWorksheet('Summary')
  writeHeader(sheet, [
    { header: 'Metric', width: 28 },
    { header: 'Value', width: 34 },
    { header: 'Note', width: 52 },
  ])

  const displayFmt = moneyFmt(ctx.displayCurrency)
  const unavailable = position === null ? 'No usable exchange rate at export time' : ''
  const countBy = (status: 'ACTIVE' | 'ARCHIVED') =>
    accountsByStatus.find((group) => group.status === status)?._count._all ?? 0

  const generatedAt = sheet.addRow(['Generated at', localDateCell(ctx.now, ctx.timezone), ''])
  generatedAt.getCell(2).numFmt = DATE_TIME_FMT

  sheet.addRow(['Timezone', ctx.timezone, ''])
  sheet.addRow(['Display currency', ctx.displayCurrency, ''])
  // `ctx.fx` is the very object the totals below were computed from — it was
  // handed to `getCurrentPosition` rather than re-fetched — so this line
  // describes the rate those figures used, not a second opinion about it.
  sheet.addRow(['FX rate', describeFx(ctx.fx, ctx.timezone), ''])

  for (const [label, value] of [
    ['Total account balance', position?.totalBalance ?? null],
    ['Net worth', position?.netWorth ?? null],
  ] as const) {
    const row = sheet.addRow([label, optionalMoneyCell(value), unavailable])
    row.getCell(2).numFmt = displayFmt
  }

  for (const [label, value] of [
    ['Monthly income', monthly.income],
    ['Monthly expense', monthly.expense],
    ['Monthly net income', monthly.netIncome],
  ] as [string, Prisma.Decimal][]) {
    const row = sheet.addRow([
      label,
      moneyCell(value),
      'Current local month, at each row’s own rate',
    ])
    row.getCell(2).numFmt = displayFmt
  }

  sheet.addRow(['Active accounts', countBy('ACTIVE'), ''])
  sheet.addRow(['Archived accounts', countBy('ARCHIVED'), ''])
  sheet.addRow(['Transactions', transactionCount, ''])
  sheet.addRow(['Transfers', transferCount, ''])
}

async function currentPositionOrNull(ctx: ExportContext): Promise<CurrentPosition | null> {
  try {
    // `{ fx: ctx.fx }` is what makes the FX line and the totals two statements
    // about ONE rate. With the rate handed in, `getCurrentPosition` makes no
    // policy call of its own, so there is no second lookup that could return a
    // different number between the line and the figure it describes — and no
    // dependence on a cache row happening to be warm. A supplied `null` with a
    // conversion to do raises `FxUnavailableError` exactly as the policy would,
    // which is the branch that blanks these two cells.
    return await getCurrentPosition(ctx.userId, ctx.displayCurrency, { fx: ctx.fx })
  } catch (error) {
    if (!isFxUnavailableError(error)) throw error
    return null
  }
}

/** The FX line: the rate, the day it applies to, when we fetched it, where it
 *  came from, and whether it is a stale-but-accepted fallback. */
function describeFx(fx: UsableRateResult | null, timezone: string): string {
  if (!fx) return 'unavailable — no usable exchange rate at export time'
  const effective = formatInTimeZone(fx.effectiveDate, 'UTC', 'yyyy-MM-dd')
  const fetched = formatInTimeZone(fx.fetchedAt, timezone, 'yyyy-MM-dd HH:mm')
  const staleness = fx.isFallback ? ' · fallback, may be out of date' : ''
  return `${fx.rateDecimal.toString()} VND per USD · effective ${effective} (UTC) · fetched ${fetched} · source ${fx.source}${staleness}`
}
