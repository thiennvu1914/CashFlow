import ExcelJS from 'exceljs'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import type { Currency } from '@/lib/currency/provider'
import { buildAccountsSheet } from './build-accounts-sheet'
import { buildBudgetsSheet } from './build-budgets-sheet'
import { buildSummarySheet } from './build-summary-sheet'
import { buildTransactionsSheet } from './build-transactions-sheet'
import { buildTransfersSheet } from './build-transfers-sheet'

/**
 * What "export all data" means, written down as a list (spec §12).
 *
 * Everything a sheet builder is allowed to know about the request, gathered
 * once and passed to every builder. In particular `fx` is resolved a single
 * time by the route (`resolveExportFx`, once, before any builder runs), so a
 * workbook cannot restate one sheet's balances at one rate and another sheet's
 * at a rate fetched a second later — and a builder has no way to ask for a rate
 * of its own.
 */
export interface ExportContext {
  /** Always from `requireUser()`; every query in every builder is scoped by it. */
  userId: string
  /** The user's `baseCurrency` — a *display* preference, never stored on a row. */
  displayCurrency: Currency
  /** The user's IANA zone, in which every date cell's wall clock is computed. */
  timezone: string
  /**
   * The one usable current rate for this workbook, or `null`.
   *
   * `null` means converted columns are left blank and said to be unavailable —
   * never filled with a fabricated number. It carries two causes that a builder
   * cannot tell apart: no usable rate existed, or the caller never asked for
   * one (the route skips `resolveExportFx` for the filtered export, which is
   * historical end to end). A builder that genuinely needs a current rate must
   * therefore not be added to the filtered workbook without turning FX back on
   * — it would silently render blanks rather than fail.
   */
  fx: UsableRateResult | null
  /** The instant the export was requested; every "as of" figure uses it. */
  now: Date
}

export type SheetBuilder = (workbook: ExcelJS.Workbook, ctx: ExportContext) => Promise<void>

/**
 * The single source of truth for the full workbook, in sheet order.
 *
 * Deliberately an explicit array of imported functions rather than a
 * side-effect registration list. A `registerExportSheet(...)` call in each
 * module would make the workbook's contents depend on which modules happened to
 * be imported — a tree-shaken build, a reordered import, or a route that forgot
 * one bare `import './build-x-sheet'` line would silently produce a workbook
 * with a sheet missing, and nothing would fail. Here the array *is* the
 * contract: the sheets are visible in one place, in the order they appear in
 * the file, and a builder that is not listed cannot run.
 *
 * Phase 5 appended `buildBudgetsSheet` — it is the only sheet here that reads
 * nothing from `ctx.fx`, because budget progress is historical end to end (see
 * that builder's own comment). Phase 6 appends Savings Goals, Debts, Debt
 * Payments, Loans, Loan Payments and Reminders — completing spec §12's full
 * workbook. Each is one import plus one entry below; nothing else changes, and
 * the route never learns their names.
 */
export const FULL_EXPORT_SHEET_BUILDERS: readonly SheetBuilder[] = [
  buildSummarySheet,
  buildAccountsSheet,
  buildTransactionsSheet,
  buildTransfersSheet,
  buildBudgetsSheet,
]

/**
 * The complete workbook for `ctx`'s user.
 *
 * Builders run in order rather than concurrently: `Workbook#addWorksheet`
 * appends, so sheet order is call order, and the registry's order is the
 * promise made to whoever opens the file.
 */
export async function buildFullWorkbook(ctx: ExportContext): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  for (const build of FULL_EXPORT_SHEET_BUILDERS) {
    await build(workbook, ctx)
  }
  return workbook
}
