import { Prisma } from '@prisma/client'
import type ExcelJS from 'exceljs'
import { listAllSavingsGoals } from '@/lib/server/services/savings-goal'
import { SAVINGS_GOAL_STATUS_LABELS } from '@/lib/ui/savings-goal-view-model'
import {
  DATE_FMT,
  DATE_TIME_FMT,
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
 * The Savings Goals sheet — every goal the user has ever set (spec §4.8, §12).
 *
 * ## History is never omitted
 *
 * `listAllSavingsGoals` is the unfiltered read, so an ARCHIVED goal is on this
 * sheet with `Status` saying so. Archiving hides a goal from the working list on
 * the page; it must never remove it from a workbook whose whole promise is
 * "export all data" — a target the user set and later put aside is part of their
 * history, and its absence would be indistinguishable from never having set it.
 * Rows come out oldest first, the order `listAllSavingsGoals` returns and the
 * order a history reads in.
 *
 * ## Each goal in its OWN currency, and no rate anywhere
 *
 * `Target`, `Progress` and `Remaining` are denominated in `goal.currency`, and
 * their number formats come from `moneyFmt(goal.currency)` — never from
 * `ctx.displayCurrency`, which is a display preference (ruling R5-3). So this
 * builder reads neither `ctx.fx` nor `ctx.displayCurrency`: a VND goal and a USD
 * goal are two separate targets rather than two views of one, there is nothing
 * here to convert, and restating a goal at today's rate would make yesterday's
 * progress percentage move every morning. The Summary sheet is the one place a
 * current rate turns positions into a single figure.
 *
 * ## `Progress %` is unclamped; `Remaining` is not
 *
 * The ratio is written as the *fraction* Excel's percentage format expects, and
 * deliberately not capped at 100 %: over-saving is a real thing a user does and
 * a spreadsheet has room to say "120 %" where the page's progress bar does not.
 * `Remaining` is the mirror image — clamped at zero, exactly as the Savings page
 * computes it, because "−200.000 still to go" is not a fact about an over-saved
 * goal. The two together are lossless: the excess is visible in the percentage.
 *
 * One query, whatever the user's history looks like.
 */
export async function buildSavingsGoalsSheet(
  workbook: ExcelJS.Workbook,
  ctx: ExportContext,
): Promise<void> {
  const goals = await listAllSavingsGoals(ctx.userId)
  const sheet = workbook.addWorksheet('Savings Goals')

  writeHeader(sheet, [
    { header: 'Name', width: 28 },
    { header: 'Target', width: 18 },
    { header: 'Progress', width: 18 },
    { header: 'Remaining', width: 18 },
    { header: 'Progress %', width: 12 },
    { header: 'Currency', width: 10 },
    { header: 'Deadline', width: 14 },
    { header: 'Status', width: 14 },
    { header: 'Note', width: 40 },
    { header: 'Created', width: 18 },
  ])

  for (const goal of goals) {
    const moneyFormat = moneyFmt(goal.currency)
    const shortfall = goal.targetAmount.sub(goal.currentProgress)
    const remaining = shortfall.isNegative() ? new Prisma.Decimal(0) : shortfall

    const written = sheet.addRow([
      goal.name,
      moneyCell(goal.targetAmount),
      moneyCell(goal.currentProgress),
      moneyCell(remaining),
      // Safe without a zero guard: `SavingsGoal_targetAmount_positive` and
      // `createSavingsGoalSchema` both forbid a target of zero, so there is no
      // stored row this could divide by.
      percentCell(goal.currentProgress.div(goal.targetAmount)),
      goal.currency,
      // The stored carrier, written straight through: a deadline is already the
      // calendar day at UTC midnight (ruling R6-7), so projecting it through
      // `ctx.timezone` would hand back the previous day for every zone west of
      // UTC. Blank when the goal has no deadline — never today's date.
      goal.deadline,
      SAVINGS_GOAL_STATUS_LABELS[goal.status],
      textCell(goal.note),
      // `createdAt` IS an instant, so it goes through `localDateCell`: the row
      // says when the user set the goal by their own clock.
      localDateCell(goal.createdAt, ctx.timezone),
    ])
    // Formatted by the GOAL's currency, not the user's display currency.
    written.getCell(2).numFmt = moneyFormat
    written.getCell(3).numFmt = moneyFormat
    written.getCell(4).numFmt = moneyFormat
    written.getCell(5).numFmt = PERCENT_FMT
    written.getCell(7).numFmt = DATE_FMT
    written.getCell(10).numFmt = DATE_TIME_FMT
  }
}
