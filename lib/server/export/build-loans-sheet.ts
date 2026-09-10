import type ExcelJS from 'exceljs'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getLoansWithOutstanding } from '@/lib/server/services/loan'
import { LOAN_FREQUENCY_LABELS, LOAN_STATUS_LABELS } from '@/lib/ui/loan-view-model'
import {
  DATE_FMT,
  DATE_TIME_FMT,
  localDateCell,
  moneyCell,
  moneyFmt,
  textCell,
  writeHeader,
} from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The number format for an annual interest rate: three fractional digits, which
 * is exactly what `Loan.interestRate`'s `Decimal(6, 3)` holds.
 *
 * Deliberately **not** Excel's percentage format, and the column is headed
 * "Interest rate (%)" instead. A percentage cell holds the *fraction* and
 * multiplies by 100 for display, so writing the stored 7.125 as a percentage
 * would need `rate.div(100)` on the way in — and a reader who re-imported that
 * column, or copied it into a formula, has no way to tell a scaled fraction from
 * an unscaled rate. The stored number is written unchanged, with the unit named
 * in the header, so the cell means the same thing as the field it came from and
 * a round trip cannot double-scale it.
 */
const INTEREST_RATE_FMT = '0.000'

/**
 * The Loans sheet — every loan the user owes, with what is still outstanding on
 * it (spec §4.10, §12).
 *
 * ## History is never omitted
 *
 * `getLoansWithOutstanding` is called without `activeOnly`, so a CLOSED loan is
 * on this sheet with `Status` saying so and its outstanding principal left
 * exactly as it stands — not zeroed. Closing a loan records that the agreement
 * is finished (repaid, refinanced, forgiven); the Summary sheet's Net Worth is
 * the one figure that stops counting it. Rows come out live loans first and
 * closed ones last, the order the Loans page renders.
 *
 * ## Principal and interest are never added together
 *
 * `Principal paid` and `Interest paid` are two columns because they answer two
 * questions: only the principal parts reduce `Outstanding principal`, while the
 * interest is what the loan has cost. Their sum is on the Loan Payments sheet as
 * each instalment's `Total`; adding them here would report a loan as repaid while
 * the lender still expects the principal back.
 *
 * ## Each loan in its OWN currency, and no rate anywhere
 *
 * Every money column is denominated in `loan.currency`, with formats from
 * `moneyFmt(loan.currency)` — never from `ctx.displayCurrency` (ruling R5-3).
 * Neither `ctx.fx` nor `ctx.displayCurrency` is read here; converting liabilities
 * into one figure is the Summary sheet's job.
 *
 * ## `Status` is derived, and needs the user's today
 *
 * OVERDUE and PAID_OFF are not stored, so the service is handed
 * `todayCalendarDateInZone(ctx.timezone, ctx.now)` — the export's own instant
 * read as a calendar day in the user's zone, so an instalment due today is not
 * called late and the whole workbook agrees on what day it is.
 *
 * Two queries for any number of loans (the service's own `findMany` plus one
 * `groupBy`), never a sum per row — and `includePayments: false`, because this
 * sheet renders the two paid totals and no individual instalment (Phase 8,
 * finding B-7). The history has a sheet of its own,
 * `buildLoanPaymentsSheet`, which is now the only place in the workbook a
 * `LoanPayment` row is read: it used to be joined here as well and then
 * discarded, so every instalment crossed the wire twice per export. The figures
 * are unchanged — they come from the service's `groupBy` sums either way.
 */
export async function buildLoansSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const today = todayCalendarDateInZone(ctx.timezone, ctx.now)
  const rows = await getLoansWithOutstanding(ctx.userId, today, { includePayments: false })
  const sheet = workbook.addWorksheet('Loans')

  writeHeader(sheet, [
    { header: 'Lender', width: 24 },
    { header: 'Principal', width: 18 },
    { header: 'Principal paid', width: 18 },
    { header: 'Interest paid', width: 18 },
    { header: 'Outstanding principal', width: 22 },
    { header: 'Currency', width: 10 },
    { header: 'Interest rate (%)', width: 16 },
    { header: 'Frequency', width: 12 },
    { header: 'Scheduled payment', width: 18 },
    { header: 'Start date', width: 14 },
    { header: 'Next due date', width: 14 },
    { header: 'Term (months)', width: 14 },
    { header: 'Status', width: 16 },
    { header: 'Notes', width: 32 },
    { header: 'Created', width: 18 },
  ])

  for (const { loan, principalPaid, interestPaid, outstandingPrincipal, displayStatus } of rows) {
    const moneyFormat = moneyFmt(loan.currency)

    const written = sheet.addRow([
      loan.lender,
      moneyCell(loan.principal),
      moneyCell(principalPaid),
      // Reported separately on purpose: interest pays nothing down.
      moneyCell(interestPaid),
      moneyCell(outstandingPrincipal),
      loan.currency,
      // The rate is not money, so it does not go through `moneyCell` — but the
      // widening happens here, at the cell boundary, and nowhere else: nothing
      // computes with this number. `toString()` first, because that is the exact
      // representation the pg adapter serialised and Zod checked to 3 decimal
      // places, so the cell carries precisely what is stored.
      Number(loan.interestRate.toString()),
      LOAN_FREQUENCY_LABELS[loan.paymentFrequency],
      moneyCell(loan.scheduledPaymentAmount),
      // Stored carriers, written straight through: both are already the calendar
      // day at UTC midnight (ruling R6-7), so projecting either through
      // `ctx.timezone` would shift it a day for most of the world.
      loan.startDate,
      loan.nextDueDate,
      loan.termMonths,
      LOAN_STATUS_LABELS[displayStatus],
      textCell(loan.notes),
      // `createdAt` IS an instant, so it goes through `localDateCell`.
      localDateCell(loan.createdAt, ctx.timezone),
    ])
    // Formatted by the LOAN's currency, not the user's display currency.
    written.getCell(2).numFmt = moneyFormat
    written.getCell(3).numFmt = moneyFormat
    written.getCell(4).numFmt = moneyFormat
    written.getCell(5).numFmt = moneyFormat
    written.getCell(7).numFmt = INTEREST_RATE_FMT
    written.getCell(9).numFmt = moneyFormat
    written.getCell(10).numFmt = DATE_FMT
    written.getCell(11).numFmt = DATE_FMT
    written.getCell(15).numFmt = DATE_TIME_FMT
  }
}
