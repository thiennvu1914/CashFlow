import type ExcelJS from 'exceljs'
import { getBudgetProgressForMonth, listAllBudgets } from '@/lib/server/services/budget'
import type { BudgetProgress } from '@/lib/server/services/budget'
import { BUDGET_STATUS_LABELS } from '@/lib/ui/budget-view-model'
import {
  DATE_FMT,
  PERCENT_FMT,
  localDateCell,
  moneyCell,
  moneyFmt,
  percentCell,
  textCell,
  writeHeader,
} from './cells'
import type { ExportContext } from './sheet-registry'

/**
 * The Budgets sheet — every budget the user has ever set, with the progress
 * against it (spec §4.6, §12).
 *
 * ## Historical only, so `ctx.fx` is unused
 *
 * This is the one full-export sheet that reads nothing from `ctx.fx`, and the
 * omission is the invariant rather than an oversight. `getBudgetProgressForMonth`
 * sums each contributing expense through `historicalAmountIn` — at the rate
 * *that row* snapshotted at entry — so a closed month's `Spent` and `Used %` are
 * permanently fixed. A budget itself carries no FX snapshot of its own to
 * restate, and there is no meaningful "current rate" for a target that was set
 * in the past: converting one at today's rate would make last March's percentage
 * move every morning. So nothing here is converted at all.
 *
 * ## Each budget in its OWN currency
 *
 * `Amount`, `Spent` and `Remaining` are denominated in `budget.currency`, and
 * their number formats come from `moneyFmt(budget.currency)` — never from
 * `ctx.displayCurrency`, which is a display preference (ruling R5-3). A USD
 * budget therefore shows cents in a workbook whose display currency is VND, and
 * there is deliberately no converted column beside it: a VND budget and a USD
 * budget are two separate targets, not two views of one.
 *
 * ## One scan per budgeted month
 *
 * `getBudgetProgressForMonth` costs two queries — the month's budgets, then the
 * month's EXPENSE rows once — and answers for *every* budget in that month. So
 * the rows are grouped by (year, month) and the call is made once per distinct
 * budgeted month, never once per budget: a user with an OVERALL and six category
 * budgets in one month pays for one ledger scan, not seven. Row order is
 * `listAllBudgets`' order (newest month first, OVERALL before its categories),
 * so the sheet reads in the same order as the Budgets page.
 */
export async function buildBudgetsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const budgets = await listAllBudgets(ctx.userId)
  const sheet = workbook.addWorksheet('Budgets')

  writeHeader(sheet, [
    { header: 'Year', width: 8 },
    { header: 'Month', width: 8 },
    { header: 'Scope', width: 12 },
    { header: 'Category', width: 24 },
    { header: 'Amount', width: 18 },
    { header: 'Currency', width: 10 },
    { header: 'Spent', width: 18 },
    { header: 'Remaining', width: 18 },
    { header: 'Used %', width: 10 },
    { header: 'Status', width: 18 },
    { header: 'Created', width: 18 },
  ])

  // Progress for every budget, indexed by budget id — one entry per distinct
  // budgeted month, in whatever order those months first appear in `budgets`.
  // Awaited in sequence rather than with `Promise.all`: the months are
  // independent, but firing an unbounded number of concurrent month scans at
  // the connection pool for a user with years of history buys nothing on a
  // download that is already streaming a whole workbook.
  const progressById = new Map<string, BudgetProgress>()
  const scanned = new Set<string>()
  for (const budget of budgets) {
    const monthKey = `${budget.year}-${budget.month}`
    if (scanned.has(monthKey)) continue
    scanned.add(monthKey)
    for (const progress of await getBudgetProgressForMonth(
      ctx.userId,
      ctx.timezone,
      budget.year,
      budget.month,
    )) {
      progressById.set(progress.budget.id, progress)
    }
  }

  for (const budget of budgets) {
    // Always found in practice: the scan above covers every month in `budgets`,
    // and `listBudgetsForMonth` inside it selects the same rows under the same
    // `userId`. Only a budget inserted between the two reads could miss, and
    // for that row the three derived cells are left blank — a zero would read
    // as "nothing spent", which is a claim this sheet has not established.
    const progress = progressById.get(budget.id)
    const moneyFormat = moneyFmt(budget.currency)

    const written = sheet.addRow([
      budget.year,
      budget.month,
      budget.scope,
      // An OVERALL budget has no category at all, so the cell is left blank —
      // never `''`, which Excel renders as a shared-string index (`cells.ts`).
      // An archived category, on the other hand, keeps its budget and its
      // history; the row says so rather than being dropped or losing the name
      // it was filed under.
      textCell(
        budget.category === null
          ? null
          : budget.category.status === 'ARCHIVED'
            ? `${budget.category.name} (archived)`
            : budget.category.name,
      ),
      moneyCell(budget.amount),
      budget.currency,
      progress === undefined ? null : moneyCell(progress.spent),
      progress === undefined ? null : moneyCell(progress.remaining),
      // `Status` comes from the band the service classified on the `Decimal`
      // itself, never from this widened number.
      progress === undefined ? null : percentCell(progress.ratio),
      progress === undefined ? null : BUDGET_STATUS_LABELS[progress.status],
      localDateCell(budget.createdAt, ctx.timezone),
    ])
    // Formatted by the BUDGET's currency, not the user's display currency.
    written.getCell(5).numFmt = moneyFormat
    written.getCell(7).numFmt = moneyFormat
    written.getCell(8).numFmt = moneyFormat
    written.getCell(9).numFmt = PERCENT_FMT
    written.getCell(11).numFmt = DATE_FMT
  }
}
