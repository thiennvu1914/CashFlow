import { Prisma } from '@prisma/client'
import type { Currency } from '@/lib/currency/provider'
import type { BudgetProgress, BudgetStatus } from '@/lib/server/services/budget'
import { formatMoney } from './format-money'

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
 */
export interface BudgetProgressDto {
  id: string
  /** 'Overall' for OVERALL scope, else the category name. */
  label: string
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
  /** e.g. "84 %" — whole percent, ratio × 100 rounded half-up at this
   *  boundary only. */
  percentLabel: string
  status: BudgetStatus
  statusLabel: string
  /** Raw values for the edit form (amount as `toFixed(2)` string — a Decimal
   *  cannot cross to the client). */
  editable: { amount: string; currency: Currency }
}

/**
 * Fixed English copy for each `BudgetStatus` band (Phase 7 replaces these
 * literals with i18n keys, same as `lib/ui/action-error-messages.ts`).
 */
export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  ok: 'Healthy',
  warning_50: 'Over half used',
  warning_80: 'Approaching limit',
  at_100: 'At limit',
  exceeded: 'Exceeded',
}

export function toBudgetProgressDto(progress: BudgetProgress): BudgetProgressDto {
  const { budget, spent, remaining, ratio, status } = progress
  const currency = budget.currency

  return {
    id: budget.id,
    label: budget.scope === 'OVERALL' ? 'Overall' : (budget.category?.name ?? ''),
    scope: budget.scope,
    categoryArchived: budget.category?.status === 'ARCHIVED',
    currency,
    amount: formatMoney(budget.amount, currency),
    spent: formatMoney(spent, currency),
    remaining: formatMoney(remaining.abs(), currency),
    over: remaining.isNegative(),
    // Clamped at 100: an exceeded budget's bar fills the track completely
    // rather than overflowing it — `statusLabel`/`percentLabel` are what say
    // "120 %", not the bar's width.
    percent: Math.min(100, ratio.mul(100).toNumber()),
    percentLabel: `${ratio.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toString()} %`,
    status,
    statusLabel: BUDGET_STATUS_LABELS[status],
    editable: { amount: budget.amount.toFixed(2), currency },
  }
}
