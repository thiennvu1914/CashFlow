import { Prisma } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale'
import type { BudgetProgress, BudgetStatus } from '@/lib/server/services/budget'
import { formatMoney, formatPercent } from './format-money'

/**
 * The budgets page's DTO boundary, as one pure function.
 *
 * `getBudgetProgressForMonth` returns `Prisma.Decimal` end to end (`spent`,
 * `remaining`, `ratio`) plus the raw `BudgetRow`; nothing downstream of this
 * file may touch a `Decimal` at all, because a `Decimal` cannot cross the
 * server-to-client-component boundary (`BudgetRowActions`, the edit form, are
 * client components). `percent` is the one `toNumber()` in this DTO — a
 * progress-bar width has to be a plain number — and `percentLabel` is rounded
 * on the `Decimal` itself, before that widening, so the label and the bar can
 * never read two different roundings of the same ratio.
 *
 * A budget is never converted to `User.baseCurrency` here or anywhere else
 * (ledger ruling R5-3): `amount`/`spent`/`remaining` are formatted in the
 * budget's own `currency`, full stop.
 *
 * No status/scope copy is baked in here at all (Phase 7): this module returns
 * the `BudgetStatus`/`BudgetScope` enums and the component that renders a row
 * translates them via `budgetStatusLabelKey`/`labels.budgetScope.OVERALL` —
 * this stays a pure function with no translator of its own.
 */
export interface BudgetProgressDto {
  id: string
  /** The category name, or `null` for an OVERALL budget — the component then
   *  renders `labels.budgetScope.OVERALL`. Was the literal 'Overall'. */
  categoryName: string | null
  scope: 'OVERALL' | 'CATEGORY'
  categoryArchived: boolean
  currency: Currency
  amount: string
  spent: string
  /** Absolute value — `over` conveys the sign, not a leading minus. */
  remaining: string
  over: boolean
  /** Bar fill 0–100, clamped; the one `toNumber()` for this DTO. */
  percent: number
  /** e.g. "84 %" — whole percent, ratio × 100 rounded half-up at this
   *  boundary only, with a NON-BREAKING space before the sign (fix round 1,
   *  finding 7) — an ordinary space let "84 %" wrap mid-figure at 375, the
   *  number stranded from its own unit. */
  percentLabel: string
  status: BudgetStatus
  /** Raw values for the edit form (amount as `toFixed(2)` string — a Decimal
   *  cannot cross to the client). */
  editable: { amount: string; currency: Currency }
}

/**
 * Fixed English copy for each `BudgetStatus` band, kept ONLY because
 * `lib/server/export/build-budgets-sheet.ts` (frozen this phase) still imports
 * it for the Excel export's `Status` column, which is English regardless of
 * the reader's locale — a workbook's column headers and enum cells are not
 * currently localised (spec §12 says nothing about it, and Phase 7's own
 * export sheets are out of scope). No UI component reads this: `toBudgetProgressDto`
 * below returns the bare `status` enum, and every renderer calls
 * `budgetStatusLabelKey` instead.
 */
export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  ok: 'Healthy',
  warning_50: 'Over half used',
  warning_80: 'Approaching limit',
  at_100: 'At limit',
  exceeded: 'Exceeded',
}

export function toBudgetProgressDto(
  progress: BudgetProgress,
  locale: Locale = DEFAULT_LOCALE,
): BudgetProgressDto {
  const { budget, spent, remaining, ratio, status } = progress
  const currency = budget.currency

  return {
    id: budget.id,
    categoryName: budget.scope === 'OVERALL' ? null : (budget.category?.name ?? null),
    scope: budget.scope,
    categoryArchived: budget.category?.status === 'ARCHIVED',
    currency,
    amount: formatMoney(budget.amount, currency, locale),
    spent: formatMoney(spent, currency, locale),
    remaining: formatMoney(remaining.abs(), currency, locale),
    over: remaining.isNegative(),
    // Clamped at 100: an exceeded budget's bar fills the track completely
    // rather than overflowing it — the status badge/`percentLabel` are what
    // say "120 %", not the bar's width.
    percent: Math.min(100, ratio.mul(100).toNumber()),
    // Rounded on the `Decimal` first (unchanged rounding semantics);
    // `formatPercent` only formats that already-rounded whole number for the
    // reader's locale and appends the sign -- it does no rounding of its own.
    percentLabel: formatPercent(
      ratio.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
      locale,
    ),
    status,
    editable: { amount: budget.amount.toFixed(2), currency },
  }
}
